import { type CssUrlDecision, filterCss } from './css';
import type { FindingFactory } from './findings';
import { ContentState, HtmlTokenizer } from './html';
import { attrValue, type MarkupAttribute, type MarkupElement, NS } from './markup';
import { typeFromName } from './sniff';
import { HtmlTree, type MarkupDoctype, type MarkupHandler } from './tree';
import { XmlCategory as C, XmlDetail as D, type DefuseFinding, type XmlFindingAction } from './types';
import {
  checkLink,
  cleanUrl,
  decodeDataUrl,
  hostsIn,
  isRelativeUrl,
  isScriptScheme,
  LabelSites,
  pathTrick,
  pseudoAttributes,
  type ResourceTarget,
  refreshTargets,
  resourceTarget,
  schemeOf,
} from './url';
import type { RawKind, Writer } from './writer';
import { UNKNOWN } from './xml';

/** What the rewrite does with a whole file found inside the document, decided by the plugins in the first pass. */
export type FileDecision = { keep: true; replacement?: string } | { keep: false };

/** A data: URL to hand to the plugins, queued during the first pass. */
export interface FileJob {
  key: string;
  url: string;
  location: string;
  /** The name the document gives the file, such as a Word 2003 binData element's w:name. */
  name?: string;
  /** Where the job's findings go in the report. */
  slot: number;
}

/**
 * Findings in document order. A slot holds the place of findings that arrive later, such as those of a plugin that
 * runs once the chunk has been read. Past 200 of one kind, one more finding counts the rest, as in office-defuse.
 */
export class FindingList {
  private readonly items: Array<DefuseFinding | DefuseFinding[]> = [];
  private readonly perKind = new Map<string, number>();
  private readonly overflow = new Map<string, DefuseFinding>();

  push(f: DefuseFinding, make?: (data: Record<string, string | number>) => DefuseFinding): void {
    const k = `${f.category}/${f.detail}`;
    const n = (this.perKind.get(k) ?? 0) + 1;
    this.perKind.set(k, n);
    if (n <= 200) {
      this.items.push(f);
      return;
    }
    let counted = this.overflow.get(k);
    if (!counted) {
      counted = make ? make({ ...f.data, count: 0 }) : { ...f, data: { ...f.data, count: 0 } };
      counted.location = 'additional occurrences';
      this.overflow.set(k, counted);
      this.items.push(counted);
    }
    if (counted.data) counted.data.count = Number(counted.data.count) + 1;
  }

  slot(): number {
    this.items.push([]);
    return this.items.length - 1;
  }

  fill(slot: number, findings: DefuseFinding[]): void {
    const s = this.items[slot];
    if (Array.isArray(s)) s.push(...findings);
  }

  all(): DefuseFinding[] {
    return this.items.flatMap(i => (Array.isArray(i) ? i : [i]));
  }

  /**
   * Adds the findings of another list, such as those of a reading that passed. Its own cap per kind already applied,
   * and its slots stay its own, so a plugin's findings still land where they belong.
   */
  merge(other: FindingList): void {
    this.items.push(...other.items);
  }
}

interface UseNode {
  /** Elements in the subtree, not counting those of id elements inside it. */
  elements: number;
  uses: string[];
  children: string[];
}

/** What the first pass decides for the second, keyed by element. */
export class Memo {
  readonly anchors = new Map<string, XmlFindingAction>();
  readonly files = new Map<string, FileDecision>();
  readonly xslt = new Map<string, XmlFindingAction>();
  /** SCRIPT/MACRO's action for a binary data element that holds a VBA project, by its key. */
  readonly macros = new Map<string, XmlFindingAction>();
  /** USE_AMPLIFICATION's action, once the first pass has counted. */
  useAction?: XmlFindingAction;
  readonly useGraph = new Map<string, UseNode>();
  readonly xsltFunctions = new Set<string>();
  readonly xsltCalls: Array<{ key: string; ns: string; name: string; location: string }> = [];
}

/** What a pass over one document shares with every Rules instance it runs, nested ones included. */
export interface RunCtx {
  factory: FindingFactory;
  /** The first pass collects findings here. The second pass and the cross-reading checks leave it undefined. */
  findings?: FindingList;
  memo: Memo;
  stripMetadata: boolean;
  tokenSize: number;
  htmlDepth: number;
  /** Data: URLs for the plugins, in the first pass. */
  jobs: FileJob[];
  /**
   * Whether a reference names a part of the MHT file this document sits in: 'kept' for a part the rewrite keeps,
   * 'dropped' for one it drops, which takes the reference with it.
   */
  isPart?: (url: string) => 'kept' | 'dropped' | undefined;
  /** Elements and attributes stripMetadata removed. */
  metadataRemoved: number;
  /** Set when a kind of content went without any finding naming it. */
  unnamedRemoval?: string;
  /** Set when a rejecting finding was made. */
  rejected: boolean;
  /** Whether the document type declaration had the format of an XSLT, SVG or XHTML file, for the inspection. */
  root?: { ns: string; local: string; xsltVersion: boolean };
}

/** Event handler attribute names, for elements of no namespace HTML knows. Any on* attribute counts on an HTML, SVG or MathML element. */
const KNOWN_HANDLERS = new Set(
  (
    'abort afterprint animationcancel animationend animationiteration animationstart auxclick beforecopy beforecut beforeinput beforematch beforepaste beforeprint ' +
    'beforetoggle beforeunload begin blur cancel canplay canplaythrough change click close contentvisibilityautostatechange contextlost contextmenu ' +
    'contextrestored copy cuechange cut dblclick drag dragend dragenter dragexit dragleave dragover dragstart drop durationchange emptied end ended error ' +
    'focus focusin focusout formdata fullscreenchange fullscreenerror gotpointercapture hashchange input invalid keydown keypress keyup languagechange load ' +
    'loadeddata loadedmetadata loadend loadstart lostpointercapture message messageerror mousedown mouseenter mouseleave mousemove mouseout mouseover mouseup ' +
    'mousewheel offline online pagehide pagereveal pageshow pageswap paste pause play playing pointercancel pointerdown pointerenter pointerleave pointermove ' +
    'pointerout pointerover pointerrawupdate pointerup popstate progress ratechange rejectionhandled repeat reset resize scroll scrollend scrollsnapchange ' +
    'scrollsnapchanging search securitypolicyviolation seeked seeking select selectionchange selectstart slotchange stalled storage submit suspend timeupdate ' +
    'toggle touchcancel touchend touchmove touchstart transitioncancel transitionend transitionrun transitionstart unhandledrejection unload volumechange ' +
    'waiting wheel activate zoom beforeactivate beforedeactivate beforeeditfocus beforeupdate cellchange controlselect dataavailable datasetchanged ' +
    'datasetcomplete deactivate errorupdate filterchange help layoutcomplete losecapture move moveend movestart propertychange readystatechange resizeend ' +
    'resizestart rowenter rowexit rowsdelete rowsinserted start stop bounce finish show svgload svgunload svgabort svgerror svgresize svgscroll svgzoom ' +
    'domactivate domfocusin domfocusout'
  )
    .split(' ')
    .map(n => `on${n}`),
);
/** Prefixes of handler names, so a browser's newer events of a known family count too. */
const HANDLER_PREFIX = /^on(mouse|key|touch|pointer|drag|focus|blur|load|unload|error|click|dblclick|context|wheel|scroll|animation|transition|before|after|webkit|moz|ms|svg|dom|page|print)/;

/** Element names an HTML reader knows. On one of these any on* attribute is a handler, whatever namespace XML put it in. */
const HTML_ELEMENTS = new Set(
  (
    'a abbr acronym address applet area article aside audio b base basefont bdi bdo bgsound big blink blockquote body br button canvas caption center cite code ' +
    'col colgroup data datalist dd del details dfn dialog dir div dl dt em embed fencedframe fieldset figcaption figure font footer form frame frameset h1 h2 h3 ' +
    'h4 h5 h6 head header hgroup hr html i iframe image img input ins isindex kbd keygen label legend li link listing main map mark marquee menu menuitem meta ' +
    'meter multicol nav nextid nobr noembed noframes noscript object ol optgroup option output p param picture plaintext portal pre progress q rb rp rt rtc ' +
    'ruby s samp script search section select selectedcontent slot small source spacer span strike strong style sub summary sup svg math table tbody td ' +
    'template textarea tfoot th thead time title tr track tt u ul var video wbr xmp'
  ).split(' '),
);

/** Link relations whose target the browser loads on its own, by what it loads. */
const PREFETCH_RELS = new Set(['prefetch', 'preload', 'preconnect', 'dns-prefetch', 'prerender', 'modulepreload', 'manifest', 'pingback', 'subresource', 'next']);
const ICON_RELS = new Set(['icon', 'shortcut', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'apple-touch-startup-image', 'mask-icon', 'fluid-icon']);

/** Attributes whose URL loads on its own wherever they appear on an HTML element. */
const RESOURCE_ATTRIBUTES = new Set(['src', 'srcset', 'poster', 'background', 'lowsrc', 'dynsrc']);
/** Attributes that hold a URL, which a javascript: or vbscript: scheme turns into script. */
const URL_ATTRIBUTES = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'data',
  'codebase',
  'cite',
  'background',
  'poster',
  'lowsrc',
  'dynsrc',
  'longdesc',
  'usemap',
  'profile',
  'manifest',
  'icon',
  'ping',
  'archive',
  'classid',
  'datasrc',
  'itemtype',
  'srcset',
]);

const SVG_ANIMATIONS = new Set(['animate', 'set', 'animatemotion', 'animatetransform', 'animatecolor']);

/** XSLT functions that read another document, the environment, or run another transform. */
const XSLT_DOCUMENT_FUNCTIONS = new Set([
  'document',
  'doc',
  'doc-available',
  'unparsed-text',
  'unparsed-text-lines',
  'unparsed-text-available',
  'collection',
  'uri-collection',
  'json-doc',
  'environment-variable',
  'available-environment-variables',
  'transform',
  'load-xquery-module',
]);
const FN_NS = 'http://www.w3.org/2005/xpath-functions';

/**
 * A function call or a named function reference: an EQName, a prefixed name or a plain one, then "(" or "#" and the
 * arity. A name right after a variable's "$", a step's "::" or another name is not one.
 */
const XPATH_CALL = /(?:^|[^\w.:$}-])(?:Q\{([^{}]*)\}|([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*)\s*(?:\(|#\s*\d)/g;

/** An XPath expression with its string literals and its comments, which nest, blanked out. */
function xpathCode(expr: string): string {
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '"' || c === "'") {
      const close = expr.indexOf(c, i + 1);
      i = close < 0 ? expr.length : close + 1;
      out += ' ';
    } else if (c === '(' && expr[i + 1] === ':') {
      let depth = 1;
      i += 2;
      while (i < expr.length && depth > 0) {
        if (expr.startsWith('(:', i)) {
          depth++;
          i += 2;
        } else if (expr.startsWith(':)', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The expressions between braces in an attribute value template or a text value template. A doubled brace is a brace. */
function templates(text: string): string[] {
  return [...text.replace(/\{\{|\}\}/g, '  ').matchAll(/\{([^{}]*)\}/g)].map(m => m[1]);
}

/** Function namespaces that only compute: the XPath and XSLT standard ones, and EXSLT's except dynamic evaluation. */
const PURE_FUNCTION_NAMESPACES = new Set([
  'http://www.w3.org/2005/xpath-functions',
  'http://www.w3.org/2005/xpath-functions/math',
  'http://www.w3.org/2005/xpath-functions/map',
  'http://www.w3.org/2005/xpath-functions/array',
  'http://www.w3.org/2001/XMLSchema',
  'http://www.w3.org/2005/xqt-errors',
  'http://exslt.org/common',
  'http://exslt.org/math',
  'http://exslt.org/sets',
  'http://exslt.org/strings',
  'http://exslt.org/dates-and-times',
  'http://exslt.org/regular-expressions',
  'http://exslt.org/random',
]);
/** Functions MSXML builds into its namespace, which only compute. A script element can add others there. */
const MSXSL_FUNCTIONS = new Set(['node-set', 'format-date', 'format-time', 'local-name', 'namespace-uri', 'number', 'string-compare', 'utc']);
/** Namespaces whose elements run script in an XSLT processor. */
const XSLT_SCRIPT_NAMESPACES = new Set<string>([NS.xslt, NS.msxsl, NS.exsltFunctions, 'http://xml.apache.org/xalan', 'http://xml.apache.org/xslt']);
/** XSLT instructions that read another document, with the attribute that names it. */
const XSLT_READERS = new Map([
  ['source-document', 'href'],
  ['stream', 'href'],
  ['merge-source', 'for-each-source'],
]);

/** Editor and tool namespaces whose elements and attributes stripMetadata removes. */
const EDITOR_NAMESPACE =
  /^(http:\/\/www\.inkscape\.org\/namespaces\/inkscape|http:\/\/sodipodi\.sourceforge\.net\/|http:\/\/ns\.adobe\.com\/|http:\/\/www\.bohemiancoding\.com\/sketch\/ns|http:\/\/purl\.org\/dc\/|http:\/\/creativecommons\.org\/ns|http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns)/;
const METADATA_META_NAMES = new Set(['author', 'generator', 'creator', 'publisher', 'progid', 'originator', 'copyright', 'owner', 'last-modified', 'revised']);

/** The limit on elements an SVG's use references make the renderer build. */
export const USE_LIMIT = 1_000_000;

/**
 * Whether the text of an XML comment, written back as a comment, ends where an HTML reader ends it too, and is
 * well-formed. An HTML reader ends "<!-->" and "<!--->" at once and a comment at "--!>". The HTML tokenizer's own
 * comments hold none of these, so only XML comments are checked.
 */
const safeXmlComment = (t: string) => !t.includes('--') && !t.startsWith('>') && !t.startsWith('->') && !t.endsWith('-');

const SSI = /^#\s*(include|exec|echo|config|fsize|flastmod|printenv|set|if|elif|else|endif)\b/i;

interface Frame {
  el: MarkupElement;
  /** 'all' keeps the element, 'content' drops its tags and keeps what it holds, 'none' drops all of it. */
  write: 'all' | 'content' | 'none';
  raw: RawKind;
  /** A style element whose text is collected and checked at its end. */
  style?: string[];
  /** A noscript element in HTML, whose raw text is read again as markup at its end. */
  noscript?: string[];
  anchor?: { key: string; text: string; title: string; sites: string[] };
  /** Namespaces of extension elements an XSLT stylesheet declares, in scope here. */
  extensions?: Set<string>;
  /** Namespace bindings in scope, for an XML element. */
  bindings?: Map<string, string>;
  /** An id element of an SVG drawing, collecting its use references. */
  useNode?: UseNode;
  /** A dropped object or applet, whose param elements go with it. */
  dropsParams?: boolean;
  /** An xsl:text element that writes its text as markup, whose text is checked at its end. */
  unescaped?: string[];
  /** An xsl:attribute element that makes a URL attribute, whose text is checked at its end. */
  urlText?: string[];
  /** Whether XSLT 3.0 text value templates are on here, as the nearest expand-text attribute says. */
  expandText?: boolean;
  /** The text of an element in a stylesheet with text value templates on, checked at its end. */
  templateText?: string[];
  /** The base64 text of a binary data element, in the first pass. */
  binData?: string[];
  /** In the second pass, the base64 of the copy a plugin wrote, which replaces the element's text. */
  binReplace?: string;
}

/** Compression and foreign types of Visio 2003 ForeignData, as the MIME type of the data they hold. */
const FOREIGN_TYPES = new Map([
  ['png', 'image/png'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['tiff', 'image/tiff'],
  ['bmp', 'image/bmp'],
  ['enhmetafile', 'image/emf'],
  ['metafile', 'image/wmf'],
]);

/**
 * An element whose text is a whole file in base64: a Word 2003 XML binData element, which holds pictures and, as
 * editdata.mso, the document's VBA project, or a Visio 2003 XML ForeignData element, which holds pictures and objects.
 */
const isBinaryData = (el: MarkupElement) => !el.html && ((el.ns === NS.wordml && el.local === 'binData') || (el.ns === NS.visio2003 && el.local === 'ForeignData'));

/** The MIME type a ForeignData element's attributes give its data. */
function foreignType(el: MarkupElement): string | undefined {
  if (el.ns !== NS.visio2003) return undefined;
  const compression = attrValue(el, 'CompressionType')?.trim().toLowerCase();
  const foreign = attrValue(el, 'ForeignType')?.trim().toLowerCase();
  return (compression && FOREIGN_TYPES.get(compression)) || (foreign && FOREIGN_TYPES.get(foreign)) || undefined;
}

export interface RulesOptions {
  /** Read by the HTML tokenizer rather than the XML one. */
  html: boolean;
  /** Prefixes memo keys, so a nested reading or an MHT part keeps keys of its own. */
  keyPrefix: string;
  /** Prefixes finding locations, such as an MHT part's name. */
  locPrefix: string;
  /** Added to line numbers, for markup read again from inside another element. */
  lineOffset: number;
  /**
   * Default true. False reads noscript elements as a browser with scripting off does: what they hold is markup, read
   * once. The text of a noscript element is read that way, so a noscript inside it is not read a third time.
   */
  scripting?: boolean;
  writer?: Writer;
}

/**
 * The rules, run over the events of either reading. Each rule makes its own finding and its action decides what the
 * rewrite does: a strip finding removes what it names, an info finding keeps it. The same rules run in both passes,
 * so the second pass, which writes, makes the decisions the first pass reported.
 */
export class Rules implements MarkupHandler {
  private readonly frames: Frame[] = [];
  private suppressed = 0;
  private styleDepth = 0;
  private base?: string;
  /** A base address that is not relative was kept, so relative addresses after it resolve elsewhere. */
  private remoteBase = false;

  /** True for an address that resolves beside the page: relative, empty or a fragment, with no remote base kept. */
  private besidePage(url: string): boolean {
    const u = cleanUrl(url);
    return !this.remoteBase && (u === '' || u.startsWith('#') || isRelativeUrl(u));
  }

  /**
   * Decides a base address. A relative one keeps the page's relative addresses on its own site, so it stays unless
   * its path is written to read as another path.
   */
  private baseAddress(loc: string, data: Record<string, string | number>, href: string): XmlFindingAction {
    const u = cleanUrl(href);
    if (u === '' || u.startsWith('#') || isRelativeUrl(u)) {
      const trick = pathTrick(href);
      return trick ? this.report(C.Navigation, D.PathTrick, loc, { ...data, reason: trick }) : this.report(C.Navigation, D.RelativeBase, loc, data);
    }
    const action = this.report(C.Navigation, D.Base, loc, data);
    if (action !== 'strip') this.remoteBase = true;
    return action;
  }
  private readonly useRoot: UseNode = { elements: 0, uses: [], children: [] };

  constructor(
    private readonly ctx: RunCtx,
    private readonly opt: RulesOptions,
  ) {}

  private get writer(): Writer | undefined {
    return this.suppressed === 0 ? this.opt.writer : undefined;
  }

  private loc(el: MarkupElement | number, attr?: string): string {
    if (typeof el === 'number') return `${this.opt.locPrefix}line ${el + this.opt.lineOffset}`;
    return `${this.opt.locPrefix}line ${el.line + this.opt.lineOffset}, <${el.qname}${attr ? ` ${attr}` : ''}>`;
  }

  /** Records a finding in the first pass and returns its action in every pass. */
  report(category: C, detail: D, location?: string, data?: Record<string, string | number>, forceStrip = false): XmlFindingAction {
    const f = this.ctx.factory.make(category, detail, location, data);
    if (forceStrip && f.action === 'info') f.action = 'strip';
    if (f.action === 'reject') this.ctx.rejected = true;
    this.ctx.findings?.push(f, d => this.ctx.factory.make(category, detail, undefined, d));
    return f.action;
  }

  private key(el: MarkupElement, what = ''): string {
    return `${this.opt.keyPrefix}${el.index}${what}`;
  }

  // ---------- element identity ----------

  /** The element's local name in the HTML namespace, or as an HTML reader of the same bytes would name it. */
  private htmlName(el: MarkupElement): string | undefined {
    if (el.ns === NS.html) return el.local.toLowerCase();
    if (!el.html) return el.qname.toLowerCase();
    return undefined;
  }

  private isHtml(el: MarkupElement, ...names: string[]): boolean {
    const n = this.htmlName(el);
    return n !== undefined && names.includes(n);
  }

  private isSvg(el: MarkupElement, ...names: string[]): boolean {
    return el.ns === NS.svg && names.includes(el.local.toLowerCase());
  }

  /** Whether any on* attribute of the element is a handler, rather than only the names KNOWN_HANDLERS lists. */
  private handlersByPrefix(el: MarkupElement): boolean {
    if (el.ns === NS.svg || el.ns === NS.mathml) return true;
    const n = this.htmlName(el);
    return n !== undefined && HTML_ELEMENTS.has(n);
  }

  private isHandler(el: MarkupElement, a: MarkupAttribute): boolean {
    if (a.ns !== '') return false;
    const name = a.local.toLowerCase();
    if (!name.startsWith('on') || name.length < 3) return false;
    return this.handlersByPrefix(el) || KNOWN_HANDLERS.has(name) || HANDLER_PREFIX.test(name);
  }

  // ---------- URLs ----------

  /**
   * Decides a URL that loads on its own. `kind` is the EXTERNAL detail for a remote or relative target. Returns
   * 'drop' when a strip finding names it, and a data: URL's plugin decision.
   */
  private resource(el: MarkupElement, attr: string, url: string, kind: D, category = C.External): CssUrlDecision {
    const loc = this.loc(el, attr);
    const target: ResourceTarget = resourceTarget(url);
    const data = { element: el.qname, attribute: attr, target: clip(url, 300) };
    const drop = (c: C, d: D) => (this.report(c, d, loc, data) === 'strip' ? 'drop' : 'keep');
    switch (target) {
      case 'none':
        return 'keep';
      case 'part':
        return this.ctx.isPart?.(url) === 'dropped' ? 'drop' : 'keep';
      case 'data':
        return this.dataUrl(el, attr, url, loc);
      case 'script':
        return drop(C.Script, D.Url);
      case 'local':
        return drop(C.External, D.LocalFile);
      case 'network':
        return drop(C.External, D.NetworkPath);
      case 'other':
        return drop(C.External, D.OtherScheme);
      default: {
        const part = this.ctx.isPart?.(url);
        if (part) return part === 'kept' ? 'keep' : 'drop';
        // A relative address loads from beside the page, as web pages do. Only one whose path is written to read as
        // another path goes.
        if (this.besidePage(url)) {
          const trick = pathTrick(url);
          if (trick) return this.report(C.External, D.PathTrick, loc, { ...data, reason: trick }) === 'strip' ? 'drop' : 'keep';
          return drop(C.External, D.Relative);
        }
        return drop(category, kind);
      }
    }
  }

  /** A data: URL that holds a whole file. The first pass queues it for the plugins; the second uses their decision. */
  private dataUrl(el: MarkupElement, attr: string, url: string, loc: string, what = ' data: URL'): CssUrlDecision {
    const key = this.key(el, `:${attr}:${this.dataSeq++}`);
    if (this.ctx.findings) {
      this.ctx.jobs.push({ key, url, location: `${loc}${what}`, slot: this.ctx.findings.slot() });
      return 'keep';
    }
    const d = this.ctx.memo.files.get(key);
    if (!d?.keep) return 'drop';
    return d.replacement === undefined ? 'keep' : { replace: d.replacement };
  }

  private dataSeq = 0;

  private link(el: MarkupElement, a: MarkupAttribute, frame: Frame): boolean {
    const raw = a.value;
    const clean = cleanUrl(raw);
    if (clean === '' || clean.startsWith('#')) return true;
    const part = this.ctx.isPart?.(raw);
    if (part) return part === 'kept';
    const v = checkLink(raw, this.base);
    const loc = this.loc(el, a.qname);
    const data: Record<string, string | number> = { element: el.qname, attribute: a.qname, target: clip(raw, 2000) };
    if (v.host) data.host = clip(v.host, 200);
    if (v.reason) data.reason = v.reason;
    const action = v.detail === D.Url ? this.report(C.Script, D.Url, loc, data) : this.report(C.Link, v.detail, loc, data);
    if (action === 'strip') return false;
    // The link's text is compared with its target once the element ends.
    if (v.detail === D.Safe && (this.isHtml(el, 'a') || this.isSvg(el, 'a'))) {
      frame.anchor = { key: this.key(el), text: '', title: attrValue(el, 'title') ?? '', sites: v.sites ?? [] };
      if (!this.ctx.findings) return this.ctx.memo.anchors.get(this.key(el)) !== 'strip';
    }
    return true;
  }

  /** Checks the url() values in an attribute that is read as CSS, such as an SVG fill. Returns the new value or undefined to drop it. */
  private cssValue(el: MarkupElement, a: MarkupAttribute, declarations: boolean): string | undefined {
    const text = declarations ? a.value : `x:${a.value}`;
    const out = filterCss(text, this.cssHooks(el, a.qname));
    if (declarations) return out;
    return out.startsWith('x:') ? out.slice(2) : undefined;
  }

  private cssHooks(el: MarkupElement, attr: string) {
    const loc = this.loc(el, attr);
    return {
      report: (c: C, d: D, data?: Record<string, string | number>) => this.report(c, d, loc, { element: el.qname, ...data }),
      url: (target: string): CssUrlDecision => {
        if (isScriptScheme(schemeOf(target))) return this.report(C.Script, D.Url, loc, { element: el.qname, attribute: attr, target: clip(target, 300) }) === 'strip' ? 'drop' : 'keep';
        return this.resource(el, attr, target, D.RemoteUrl, C.Style);
      },
    };
  }

  // ---------- events ----------

  start(el: MarkupElement): void {
    const parent = this.frames[this.frames.length - 1];
    const frame: Frame = { el, write: 'all', raw: undefined };
    if (!el.html) {
      frame.bindings = new Map(parent?.bindings);
      for (const [p, u] of el.namespaces) frame.bindings.set(p, u);
    }
    frame.extensions = parent?.extensions;
    this.ctx.root ??= { ns: el.ns, local: el.local, xsltVersion: el.attributes.some(a => a.ns === NS.xslt && a.local === 'version') };
    this.element(el, frame, parent);
    this.track(el, frame);
    // Attributes are checked on an element that goes too, so the report names everything the file holds.
    const attrs = this.attributes(el, frame);
    if (frame.write === 'all' && el.ns === NS.html && el.html) {
      const n = el.local;
      if (n === 'style') frame.raw = 'style';
      else if (n === 'script') frame.raw = 'script';
      else if (n === 'xmp' || n === 'noembed' || n === 'noframes' || n === 'iframe' || n === 'plaintext') frame.raw = 'rawtext';
      else if (n === 'title' || n === 'textarea') frame.raw = 'rcdata';
      if (n === 'noscript' && this.opt.scripting !== false) frame.noscript = [];
    }
    if (this.isHtml(el, 'style') || this.isSvg(el, 'style')) {
      frame.style = [];
      this.styleDepth++;
    }
    if (isBinaryData(el)) this.binaryStart(el, frame);
    if (frame.write === 'all') this.writer?.start(el, attrs);
    this.frames.push(frame);
    if (frame.write === 'none') this.suppressed++;
  }

  /** The element-level rules, which can drop the element, or its tags only. */
  /**
   * `at` is the element the finding locations name: `el` itself, or the XSLT instruction that makes an element named
   * `el` in the transform's result.
   */
  private element(el: MarkupElement, frame: Frame, parent: Frame | undefined, at = el): void {
    const loc = this.loc(at);
    const data = { element: el.qname };
    const drop = (c: C, d: D, mode: 'content' | 'none', extra?: Record<string, string | number>) => {
      if (this.report(c, d, loc, { ...data, ...extra }) === 'strip' && frame.write !== 'none') frame.write = mode;
    };
    const name = this.htmlName(el);
    if (name === 'script' || this.isSvg(el, 'script', 'handler') || (el.ns === NS.xmlEvents && el.local === 'listener')) drop(C.Script, D.Element, 'none');
    // A caching server or a JSP container reads these by their prefix, whatever namespace it is bound to. Written as
    // empty elements in HTML, they hold the rest of the page, which stays.
    const prefix = el.qname.toLowerCase().split(':', 1)[0];
    if (prefix === 'esi' && el.qname.includes(':')) drop(C.Server, D.Esi, 'content');
    if (prefix === 'jsp' && el.qname.includes(':')) drop(C.Server, D.Code, 'content', { kind: 'jsp' });
    if ((el.ns === NS.hta && el.local.toLowerCase() === 'application') || name === 'hta:application') this.report(C.Format, D.Hta, loc, data);
    if (name === 'iframe' || name === 'portal' || name === 'fencedframe') drop(C.Embedded, D.Iframe, 'none');
    if (name === 'frame') drop(C.Embedded, D.Frame, 'none');
    if (name === 'frameset') drop(C.Embedded, D.Frame, 'content');
    if (name === 'object' || name === 'applet') {
      drop(C.Embedded, name === 'object' ? D.Object : D.Applet, 'content');
      if (frame.write !== 'all') frame.dropsParams = true;
    }
    if (name === 'embed') drop(C.Embedded, D.Embed, 'none');
    if (name === 'param' && parent?.dropsParams) frame.write = 'none';
    if (name === 'form') drop(C.Form, D.Submit, 'content');
    if (name === 'isindex') drop(C.Form, D.Submit, 'content');
    if (name === 'base' && attrValue(el, 'href') !== undefined) {
      const href = attrValue(el, 'href') ?? '';
      if (this.baseAddress(loc, { ...data, target: clip(href, 300) }, href) === 'strip') frame.write = 'none';
      else this.base ??= href;
    }
    if (name === 'meta') this.meta(el, frame, loc);
    if (name === 'link') this.linkElement(el, frame, loc);
    if (this.isSvg(el, 'foreignobject')) drop(C.Svg, D.ForeignObject, 'none');
    if (this.isSvg(el, 'use')) this.use(el, frame, loc);
    if (el.ns === NS.svg && SVG_ANIMATIONS.has(el.local.toLowerCase())) {
      const target = (attrValue(el, 'attributeName') ?? '').toLowerCase().replace(/^.*:/, '');
      const values = ['values', 'to', 'from', 'by'].map(k => attrValue(el, k) ?? '').join(' ');
      if (target === 'href' || target.startsWith('on') || /(java|vb|live)script\s*:|data\s*:/i.test(values.replace(/[\s\0]/g, ''))) drop(C.Script, D.Animation, 'none', { attribute: target });
    }
    if ((el.ns === NS.xinclude || el.ns === NS.xinclude2003) && el.local === 'include') drop(C.Xml, D.XInclude, 'none', { href: clip(attrValue(el, 'href') ?? '', 300) });
    if (!el.html && at === el) this.xslt(el, frame, parent, loc);
    if (this.ctx.stripMetadata && frame.write === 'all') {
      const meta = (el.ns === NS.svg && el.local === 'metadata') || EDITOR_NAMESPACE.test(el.ns) || (name === 'meta' && METADATA_META_NAMES.has((attrValue(el, 'name') ?? '').toLowerCase()));
      if (meta) {
        frame.write = 'none';
        this.ctx.metadataRemoved++;
      }
    }
    if (parent && parent.write === 'all' && parent.style && frame.write === 'all') {
      // Text in an element inside a style element reaches some readers' style sheets and not others'.
      drop(C.Style, D.MarkupInStyle, 'none');
    }
  }

  private meta(el: MarkupElement, frame: Frame, loc: string): void {
    const equiv = (attrValue(el, 'http-equiv') ?? '').trim().toLowerCase();
    if (equiv === 'refresh') {
      const content = attrValue(el, 'content') ?? '';
      const data = { element: 'meta', content: clip(content, 300) };
      const targets = refreshTargets(content);
      const script = targets?.find(t => isScriptScheme(schemeOf(t)));
      if (script !== undefined && this.report(C.Script, D.Url, loc, { element: 'meta', target: clip(script, 300) }) === 'strip') frame.write = 'none';
      // A refresh stays when every address a reader can take from it is beside the page, as a relative link does.
      let action: XmlFindingAction;
      if (targets?.every(t => this.besidePage(t))) {
        const trick = targets.map(t => pathTrick(t)).find(r => r !== undefined);
        action = trick ? this.report(C.Navigation, D.PathTrick, loc, { ...data, reason: trick }) : this.report(C.Navigation, D.RelativeRefresh, loc, data);
      } else action = this.report(C.Navigation, D.Refresh, loc, data);
      if (action === 'strip') frame.write = 'none';
    } else if (equiv === 'set-cookie') {
      if (this.report(C.Navigation, D.SetCookie, loc, { element: 'meta' }) === 'strip') frame.write = 'none';
    }
  }

  private linkElement(el: MarkupElement, frame: Frame, loc: string): void {
    const href = attrValue(el, 'href');
    if (href === undefined) return;
    const rels = (attrValue(el, 'rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const data = { element: 'link', rel: rels.join(' '), target: clip(href, 300) };
    let kind: D | undefined;
    if (rels.includes('import')) kind = D.Import;
    else if (rels.includes('stylesheet')) kind = D.Stylesheet;
    else if (rels.some(r => PREFETCH_RELS.has(r))) kind = D.Prefetch;
    else if (rels.some(r => ICON_RELS.has(r))) kind = D.Resource;
    if (isScriptScheme(schemeOf(href))) {
      if (this.report(C.Script, D.Url, loc, data) === 'strip') frame.write = 'none';
      return;
    }
    if (kind === undefined) return;
    if (kind === D.Resource) {
      if (this.resource(el, 'href', href, D.Resource) === 'drop') frame.write = 'none';
      return;
    }
    const target = resourceTarget(href);
    if (target === 'data') {
      if (this.dataUrl(el, 'href', href, `${loc.slice(0, -1)} href>`) === 'drop') frame.write = 'none';
      return;
    }
    const part = target === 'part' || target === 'remote' ? this.ctx.isPart?.(href) : undefined;
    if (part === 'dropped') frame.write = 'none';
    if (target === 'none' || part) return;
    // A style sheet or a hint at a relative address loads from beside the page, as web pages do. An HTML import runs
    // script, so it goes wherever it points.
    if (kind !== D.Import && this.besidePage(href)) {
      const trick = pathTrick(href);
      const action = trick ? this.report(C.External, D.PathTrick, loc, { ...data, reason: trick }) : this.report(C.External, D.Relative, loc, data);
      if (action === 'strip') frame.write = 'none';
      return;
    }
    if (this.report(C.External, kind, loc, data) === 'strip') frame.write = 'none';
  }

  private use(el: MarkupElement, frame: Frame, loc: string): void {
    const href = attrValue(el, 'href') ?? attrValue(el, 'href', NS.xlink) ?? '';
    const clean = cleanUrl(href);
    if (clean === '') return;
    if (clean.startsWith('#')) {
      const target = clean.slice(1);
      const node = this.nearestUseNode();
      node.uses.push(target);
      if (!this.ctx.findings && this.ctx.memo.useAction === 'strip') frame.write = 'none';
      return;
    }
    // A file beside the page, such as an icon sheet, loads as a relative image does.
    if (this.besidePage(href)) {
      const data = { element: el.qname, target: clip(href, 300) };
      const trick = pathTrick(href);
      const action = trick ? this.report(C.External, D.PathTrick, loc, { ...data, reason: trick }) : this.report(C.External, D.Relative, loc, data);
      if (action === 'strip') frame.write = 'none';
      return;
    }
    if (this.report(C.Svg, D.UseExternal, loc, { element: el.qname, target: clip(href, 300) }) === 'strip') frame.write = 'none';
  }

  private nearestUseNode(): UseNode {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const n = this.frames[i].useNode;
      if (n) return n;
    }
    return this.useRoot;
  }

  /** Counts elements and id elements for the use check. */
  private track(el: MarkupElement, frame: Frame): void {
    if (!this.ctx.findings) return;
    const enclosing = this.nearestUseNode();
    const id = el.attributes.find(a => (a.local === 'id' && a.ns === '') || (a.local === 'id' && a.ns === NS.xml))?.value;
    if (id !== undefined && el.ns === NS.svg && !this.ctx.memo.useGraph.has(id)) {
      const node: UseNode = { elements: 1, uses: [], children: [] };
      this.ctx.memo.useGraph.set(id, node);
      enclosing.children.push(id);
      frame.useNode = node;
    } else enclosing.elements++;
  }

  /** The root of the use graph, for the count once the first pass ends. */
  get uses(): UseNode {
    return this.useRoot;
  }

  /** XSLT rules for an element of an XML document. */
  private xslt(el: MarkupElement, frame: Frame, parent: Frame | undefined, loc: string): void {
    const data = { element: el.qname };
    const drop = (d: D, extra?: Record<string, string | number>) => {
      if (this.report(C.Xslt, d, loc, { ...data, ...extra }) === 'strip') frame.write = 'none';
    };
    const isXsl = el.ns === NS.xslt;
    if (isXsl && (el.local === 'include' || el.local === 'import' || el.local === 'import-schema' || el.local === 'use-package'))
      drop(D.Include, { href: clip(attrValue(el, 'href') ?? attrValue(el, 'schema-location') ?? attrValue(el, 'name') ?? '', 300) });
    if (isXsl && el.local === 'result-document') drop(D.ResultDocument, { href: clip(attrValue(el, 'href') ?? '', 300) });
    const reads = isXsl ? XSLT_READERS.get(el.local) : undefined;
    if (reads !== undefined && attrValue(el, reads) !== undefined) drop(D.Document, { href: clip(attrValue(el, reads) ?? '', 300) });
    if (isXsl && el.local === 'evaluate') drop(D.Evaluate, { xpath: clip(attrValue(el, 'xpath') ?? '', 200) });
    if (XSLT_SCRIPT_NAMESPACES.has(el.ns) && (el.local === 'script' || el.local === 'component')) drop(D.Script, { language: clip(attrValue(el, 'language') ?? '', 40) });
    if ((isXsl || el.ns === NS.exsltFunctions) && el.local === 'function') {
      const fname = attrValue(el, 'name') ?? '';
      const colon = fname.indexOf(':');
      const ns = colon > 0 ? frame.bindings?.get(fname.slice(0, colon)) : undefined;
      if (ns !== undefined) this.ctx.memo.xsltFunctions.add(ns);
    }
    if (isXsl) this.constructs(el, frame, parent, loc);
    // XSLT 3.0 reads {...} in text as an expression where expand-text is on, on the element or one around it.
    const expand = isXsl ? attrValue(el, 'expand-text') : el.attributes.find(a => a.ns === NS.xslt && a.local === 'expand-text')?.value;
    frame.expandText = expand === undefined ? parent?.expandText : ['yes', 'true', '1'].includes(expand.trim());
    if (frame.expandText && frame.write !== 'none') {
      frame.templateText = [];
      if (!this.ctx.findings && this.ctx.memo.xslt.get(this.key(el, ':text')) === 'strip') frame.write = 'none';
    }
    // Extension elements: their namespaces are declared on the stylesheet, or on a literal result element.
    const declared = isXsl ? attrValue(el, 'extension-element-prefixes') : el.attributes.find(a => a.ns === NS.xslt && a.local === 'extension-element-prefixes')?.value;
    if (declared !== undefined) {
      const set = new Set(parent?.extensions);
      for (const p of declared.trim().split(/\s+/)) {
        const uri = frame.bindings?.get(p === '#default' ? '' : p);
        if (uri) set.add(uri);
      }
      frame.extensions = set;
    }
    if (parent?.extensions?.has(el.ns) && el.ns !== 'http://exslt.org/functions' && frame.write !== 'none') drop(D.ExtensionElement, { namespace: clip(el.ns, 200) });
    // Expressions: every attribute of an XSLT instruction, and the attribute value templates of other elements inside a stylesheet.
    if (!this.inStylesheet(el, parent)) return;
    for (const a of el.attributes) {
      // An attribute in the XSLT namespace on a literal result element, such as xsl:use-when, is an expression too.
      const whole = isXsl || a.ns === NS.xslt;
      if (!whole && !a.value.includes('{')) continue;
      const exprs = whole ? [a.value] : templates(a.value);
      for (const expr of exprs) this.xpath(el, frame, expr, a.qname);
    }
  }

  /**
   * XSLT instructions that make the transform's result: an element or attribute named on the instruction, text written
   * as markup, and a character map that writes markup in place of a character.
   */
  private constructs(el: MarkupElement, frame: Frame, parent: Frame | undefined, loc: string): void {
    const name = attrValue(el, 'name');
    const literal = name !== undefined && !name.includes('{');
    if (el.local === 'element' && literal) {
      // The element rules run on the element the result gets, and a strip finding drops the instruction.
      const colon = name.indexOf(':');
      const nsAttr = attrValue(el, 'namespace');
      const ns = nsAttr !== undefined && !nsAttr.includes('{') ? nsAttr : (frame.bindings?.get(colon < 0 ? '' : name.slice(0, colon)) ?? '');
      this.element({ ...el, qname: name, local: colon < 0 ? name : name.slice(colon + 1), ns, attributes: [], namespaces: [] }, frame, parent, el);
    }
    if (el.local === 'attribute' && literal) {
      const local = name.slice(name.indexOf(':') + 1).toLowerCase();
      if (local.length > 2 && (KNOWN_HANDLERS.has(local) || HANDLER_PREFIX.test(local))) {
        if (this.report(C.Script, D.EventHandler, loc, { element: el.qname, attribute: name }) === 'strip') frame.write = 'none';
      } else if (URL_ATTRIBUTES.has(local)) {
        frame.urlText = [];
        if (!this.ctx.findings && this.ctx.memo.xslt.get(this.key(el, ':url')) === 'strip') frame.write = 'none';
      }
    }
    if (el.local === 'text' && attrValue(el, 'disable-output-escaping')?.trim() === 'yes') frame.unescaped = [];
    if (el.local === 'output-character') {
      const holds = this.probe(attrValue(el, 'string') ?? '', el);
      if (holds.length && this.report(C.Xslt, D.UnescapedOutput, loc, { element: el.qname, holds: holds.join(', ') }) === 'strip') frame.write = 'none';
    }
  }

  /**
   * Reads text an XSLT transform writes as markup, as HTML in body content, without writing it or reporting what it
   * holds. Returns the kinds of finding that would change it, and "data: URL" for one the plugins would get.
   */
  private probe(text: string, el: MarkupElement): string[] {
    const findings = new FindingList();
    const ctx: RunCtx = { ...this.ctx, findings, memo: new Memo(), jobs: [], metadataRemoved: 0, rejected: false, unnamedRemoval: undefined, stripMetadata: false };
    readFragment(text, new Rules(ctx, { html: true, keyPrefix: `${this.key(el)}~`, locPrefix: '', lineOffset: 0 }), ctx);
    const kinds = findings
      .all()
      .filter(f => f.action !== 'info')
      .map(f => `${f.category}/${f.detail}`);
    if (ctx.jobs.length) kinds.push('data: URL');
    if (ctx.unnamedRemoval) kinds.push(`${C.Processing}/${D.ContentRemoved}`);
    return [...new Set(kinds)];
  }

  private stylesheet = false;

  private inStylesheet(el: MarkupElement, parent: Frame | undefined): boolean {
    if (el.ns === NS.xslt && (el.local === 'stylesheet' || el.local === 'transform')) this.stylesheet = true;
    if (!parent && el.attributes.some(a => a.ns === NS.xslt && a.local === 'version')) this.stylesheet = true;
    return this.stylesheet || el.ns === NS.xslt;
  }

  /** Finds the function calls in an XPath expression, outside its string literals. */
  /**
   * Finds the function calls and named function references in an XPath expression, outside its string literals and
   * comments, and reports those that read files, evaluate code or call extensions. `key` is set for text value
   * templates, whose element the second pass decides at its start, from what the first pass found at its end.
   */
  private xpath(el: MarkupElement, frame: Frame, expr: string, attr: string, textKey?: string): void {
    const loc = this.loc(el, attr || undefined);
    const decide = (action: XmlFindingAction) => {
      if (action !== 'strip') return;
      frame.write = 'none';
      if (textKey !== undefined) this.ctx.memo.xslt.set(textKey, 'strip');
    };
    for (const m of xpathCode(expr).matchAll(XPATH_CALL)) {
      const [, uri, prefix, local] = m;
      const q = uri !== undefined ? `Q{${uri}}${local}` : prefix !== undefined ? `${prefix}:${local}` : local;
      const ns = uri ?? (prefix !== undefined ? (frame.bindings?.get(prefix) ?? '') : FN_NS);
      if (ns === FN_NS) {
        if (XSLT_DOCUMENT_FUNCTIONS.has(local)) decide(this.report(C.Xslt, D.Document, loc, { element: el.qname, function: q }));
        // A function found by name while the transform runs can be any function the processor has.
        else if (local === 'function-lookup') decide(this.report(C.Xslt, D.Evaluate, loc, { element: el.qname, function: q }));
        continue;
      }
      if (PURE_FUNCTION_NAMESPACES.has(ns) || (ns === NS.msxsl && MSXSL_FUNCTIONS.has(local))) continue;
      // Whether the stylesheet declares the function itself is known only once the first pass ends.
      const key = textKey ?? this.key(el, `:${attr}:${q}`);
      if (this.ctx.findings) this.ctx.memo.xsltCalls.push({ key, ns, name: q, location: loc });
      else if (this.ctx.memo.xslt.get(key) === 'strip') frame.write = 'none';
    }
  }

  /** The attribute rules for an element that stays. Returns the attributes to write. */
  private attributes(el: MarkupElement, frame: Frame): MarkupAttribute[] {
    const out: MarkupAttribute[] = [];
    const htmlish = el.html || el.ns === NS.html || el.ns === NS.svg || el.ns === NS.mathml || HTML_ELEMENTS.has(el.qname.toLowerCase());
    const name = this.htmlName(el);
    for (const a of el.attributes) {
      const kept = this.attribute(el, frame, a, htmlish, name);
      if (kept !== undefined) out.push(kept);
    }
    return out;
  }

  private attribute(el: MarkupElement, frame: Frame, a: MarkupAttribute, htmlish: boolean, name: string | undefined): MarkupAttribute | undefined {
    const local = el.html ? a.local.toLowerCase() : a.local;
    const lowerLocal = local.toLowerCase();
    const qlower = a.qname.toLowerCase();
    if (el.html && /["'<>/=\s\0]/.test(a.qname)) {
      // A name a reader could split differently from this one, from markup such as href="x""onclick=...
      this.ctx.unnamedRemoval ??= 'attribute';
      return undefined;
    }
    if (this.isHandler(el, a)) return this.report(C.Script, D.EventHandler, this.loc(el, a.qname), { element: el.qname, attribute: a.qname, value: clip(a.value, 200) }) === 'strip' ? undefined : a;
    if (this.ctx.stripMetadata && (EDITOR_NAMESPACE.test(a.ns) || /^(inkscape|sodipodi):/.test(qlower))) {
      this.ctx.metadataRemoved++;
      return undefined;
    }
    if (a.ns === NS.xml && a.local === 'base') {
      if (this.baseAddress(this.loc(el, a.qname), { element: el.qname, target: clip(a.value, 300) }, a.value) === 'strip') return undefined;
      this.base ??= a.value;
      return a;
    }
    if (el.ns === NS.xslt && a.ns === '' && a.local === 'disable-output-escaping' && a.value.trim() === 'yes') {
      // The text of xsl:text is known, and is checked at its end. Any other instruction writes what the input holds.
      if (el.local === 'text') return !this.ctx.findings && this.ctx.memo.xslt.get(this.key(el, ':unescaped')) === 'strip' ? undefined : a;
      return this.report(C.Xslt, D.UnescapedOutput, this.loc(el, a.qname), { element: el.qname }) === 'strip' ? undefined : a;
    }
    // A RELAX NG grammar loads another with the href of externalRef and include, as XML Schema does with schemaLocation.
    const schemaHint =
      (a.ns === NS.xsi && (a.local === 'schemaLocation' || a.local === 'noNamespaceSchemaLocation')) ||
      (el.ns === NS.xsd && a.ns === '' && a.local === 'schemaLocation') ||
      (el.ns === NS.rng && (el.local === 'externalRef' || el.local === 'include') && a.ns === '' && a.local === 'href');
    if (schemaHint) {
      // xsi:schemaLocation pairs each namespace with a location.
      const words = a.value.trim().split(/\s+/);
      const targets = a.ns === NS.xsi && a.local === 'schemaLocation' ? words.filter((_, i) => i % 2 === 1) : words;
      if (targets.every(onW3c)) return a;
      const data = { element: el.qname, attribute: a.qname, target: clip(a.value, 300) };
      // A schema beside the document stays, as every relative address does. One elsewhere is a fetch a validator makes.
      const elsewhere = targets.filter(t => !onW3c(t));
      if (elsewhere.length && elsewhere.every(t => this.besidePage(t))) {
        const trick = elsewhere.map(t => pathTrick(t)).find(r => r !== undefined);
        const action = trick ? this.report(C.External, D.PathTrick, this.loc(el, a.qname), { ...data, reason: trick }) : this.report(C.External, D.Relative, this.loc(el, a.qname), data);
        return action === 'strip' ? undefined : a;
      }
      return this.report(C.Xml, D.SchemaLocation, this.loc(el, a.qname), data) === 'strip' ? undefined : a;
    }
    // An HTML reader applies a style attribute on any element, so every one is checked.
    if (a.ns === '' && lowerLocal === 'style') {
      const v = this.cssValue(el, a, true);
      return v === undefined ? undefined : { ...a, value: v };
    }
    // Links a click follows.
    const isHref = (lowerLocal === 'href' && (a.ns === '' || a.ns === NS.xlink)) || qlower === 'xlink:href';
    if (isHref && (this.isHtml(el, 'a', 'area') || this.isSvg(el, 'a') || el.ns === NS.mathml || (!htmlish && a.ns === NS.xlink))) return this.link(el, a, frame) ? a : undefined;
    if (isHref && el.ns === NS.svg) {
      // An SVG element that refers to another document loads it on its own; use has a rule of its own.
      if (this.isSvg(el, 'use')) return a;
      const d = this.resource(el, a.qname, a.value, D.Resource);
      return d === 'drop' ? undefined : d === 'keep' ? a : { ...a, value: d.replace };
    }
    // These attributes do something only on the HTML elements that define them.
    if (a.ns === '' && name !== undefined && HTML_ELEMENTS.has(name)) {
      if (lowerLocal === 'srcdoc' && name === 'iframe') {
        // The value is a whole page, which goes to the plugins as a file, as a data: URL does.
        const d = this.dataUrl(el, a.qname, `data:text/html;base64,${Buffer.from(a.value, 'utf8').toString('base64')}`, this.loc(el, a.qname), '');
        if (d === 'keep' || d === 'drop') return d === 'keep' ? a : undefined;
        const page = decodeDataUrl(d.replace);
        // The value is the plugin's bytes as they are, so the check of the output knows them again.
        return page ? { ...a, value: page.bytes.toString('utf8') } : undefined;
      }
      if (lowerLocal === 'formaction') {
        if (isScriptScheme(schemeOf(a.value))) return this.report(C.Script, D.Url, this.loc(el, a.qname), { element: el.qname, target: clip(a.value, 300) }) === 'strip' ? undefined : a;
        return this.report(C.Form, D.Submit, this.loc(el, a.qname), { element: el.qname, target: clip(a.value, 300) }) === 'strip' ? undefined : a;
      }
      if (lowerLocal === 'ping' || (lowerLocal === 'manifest' && name === 'html')) {
        const data = { element: el.qname, attribute: a.qname, target: clip(a.value, 300) };
        // ping holds a list of addresses. Relative ones stay on the page's own site, as a relative prefetch does.
        const targets = lowerLocal === 'ping' ? a.value.split(/[\t\n\f\r ]+/).filter(Boolean) : [a.value];
        if (targets.length > 0 && targets.every(t => this.besidePage(t))) {
          const trick = targets.map(t => pathTrick(t)).find(r => r !== undefined);
          const action = trick ? this.report(C.External, D.PathTrick, this.loc(el, a.qname), { ...data, reason: trick }) : this.report(C.External, D.Relative, this.loc(el, a.qname), data);
          return action === 'strip' ? undefined : a;
        }
        return this.report(C.External, D.Prefetch, this.loc(el, a.qname), data) === 'strip' ? undefined : a;
      }
      if (lowerLocal === 'type' && name === 'input' && a.value.trim().toLowerCase() === 'password') this.report(C.Form, D.Password, this.loc(el, a.qname), { element: el.qname });
      const loads =
        (RESOURCE_ATTRIBUTES.has(lowerLocal) && !(lowerLocal === 'src' && name === 'input' && (attrValue(el, 'type') ?? '').trim().toLowerCase() !== 'image')) ||
        (name === 'object' && (lowerLocal === 'data' || lowerLocal === 'codebase')) ||
        (name === 'applet' && (lowerLocal === 'code' || lowerLocal === 'codebase' || lowerLocal === 'archive' || lowerLocal === 'object'));
      if (loads || (lowerLocal === 'src' && (name === 'xml' || name === 'bgsound'))) {
        if (lowerLocal === 'srcset') {
          for (const candidate of a.value.split(',')) {
            const url = candidate.trim().split(/\s+/)[0] ?? '';
            if (url && this.resource(el, a.qname, url, D.Resource) !== 'keep') return undefined;
          }
          return a;
        }
        const d = this.resource(el, a.qname, a.value, D.Resource);
        return d === 'drop' ? undefined : d === 'keep' ? a : { ...a, value: d.replace };
      }
      if (URL_ATTRIBUTES.has(lowerLocal) && isScriptScheme(schemeOf(a.value)))
        return this.report(C.Script, D.Url, this.loc(el, a.qname), { element: el.qname, attribute: a.qname, target: clip(a.value, 300) }) === 'strip' ? undefined : a;
    }
    // A CSS escape can spell url( out of other letters, as u\72l(, which a CSS reader decodes, so such a value is read too.
    if (htmlish && /url\s*\(|\\/i.test(a.value)) {
      const v = this.cssValue(el, a, false);
      return v === undefined ? undefined : { ...a, value: v };
    }
    if (name === 'meta' && el.html) {
      // The output is UTF-8, so a declaration of any other encoding is rewritten to say so.
      if (lowerLocal === 'charset') return { ...a, value: 'utf-8' };
      if (lowerLocal === 'content' && (attrValue(el, 'http-equiv') ?? '').trim().toLowerCase() === 'content-type')
        return { ...a, value: a.value.replace(/charset\s*=\s*["']?[^"';\s]*["']?/i, 'charset=utf-8') };
    }
    return a;
  }

  end(el: MarkupElement, explicit: boolean): void {
    const frame = this.frames.pop();
    if (!frame) return;
    if (frame.write === 'none') this.suppressed--;
    if (frame.style) {
      this.styleDepth--;
      const css = filterCss(frame.style.join(''), this.cssHooks(el, ''));
      if (frame.write === 'all') this.writer?.text(css, frame.raw === 'style' ? 'style' : undefined);
    }
    if (frame.noscript) this.noscript(el, frame);
    if (frame.anchor && this.ctx.findings) this.anchorEnd(el, frame);
    if (frame.templateText && this.ctx.findings) {
      for (const expr of templates(frame.templateText.join(''))) this.xpath(el, frame, expr, '', this.key(el, ':text'));
    }
    if (frame.unescaped && this.ctx.findings) {
      const holds = this.probe(frame.unescaped.join(''), el);
      if (holds.length) this.ctx.memo.xslt.set(this.key(el, ':unescaped'), this.report(C.Xslt, D.UnescapedOutput, this.loc(el), { element: el.qname, holds: holds.join(', ') }));
    }
    if (frame.urlText && this.ctx.findings) {
      const url = frame.urlText.join('');
      if (isScriptScheme(schemeOf(url)))
        this.ctx.memo.xslt.set(this.key(el, ':url'), this.report(C.Script, D.Url, this.loc(el), { element: el.qname, attribute: attrValue(el, 'name') ?? '', target: clip(url, 300) }));
    }
    if (frame.binData && this.ctx.findings) this.binaryEnd(el, frame.binData.join(''));
    if (frame.binReplace !== undefined && frame.write === 'all') this.writer?.text(frame.binReplace, frame.raw);
    // An element HTML closed on its own gets no end tag, except in SVG or MathML, which XML readers need closed.
    if (frame.write === 'all' && (explicit || !el.html || el.ns !== NS.html)) this.writer?.end(el);
  }

  /**
   * A binary data element. The first pass collects its text. The second keeps it, drops it, or writes the copy a
   * plugin made in place of its text, as the plugins and SCRIPT/MACRO decided.
   */
  private binaryStart(el: MarkupElement, frame: Frame): void {
    if (frame.write === 'none') return;
    const key = this.key(el, ':binData');
    if (this.ctx.findings) {
      frame.binData = [];
      return;
    }
    const d = this.ctx.memo.files.get(key);
    if (this.ctx.memo.macros.get(key) === 'strip' || !d?.keep) frame.write = 'none';
    else if (d.replacement !== undefined) frame.binReplace = d.replacement.slice(d.replacement.indexOf(',') + 1);
  }

  /** Queues a binary data element's file for the plugins, and reports a VBA project in it. */
  private binaryEnd(el: MarkupElement, text: string): void {
    const findings = this.ctx.findings;
    if (!findings) return;
    const key = this.key(el, ':binData');
    const b64 = text.replace(/[\t\n\f\r ]+/g, '');
    if (!b64) {
      this.ctx.memo.files.set(key, { keep: true });
      return;
    }
    const name = attrValue(el, 'name', NS.wordml);
    const loc = this.loc(el);
    // An ActiveMime blob holds a VBA project. Word 2003 XML keeps one as editdata.mso, and loads it with the document.
    if (Buffer.from(b64.slice(0, 16), 'base64').toString('latin1').startsWith('ActiveMime')) {
      this.ctx.memo.macros.set(key, this.report(C.Script, D.Macro, loc, { element: el.qname, name: name ?? '' }));
    }
    const type = typeFromName(name) ?? foreignType(el) ?? 'application/octet-stream';
    this.ctx.jobs.push({ key, url: `data:${type};base64,${b64}`, location: `${loc} binary data`, slot: findings.slot(), name });
  }

  private anchorEnd(el: MarkupElement, frame: Frame): void {
    const a = frame.anchor;
    if (!a) return;
    const labels = new LabelSites([...hostsIn(a.text), ...hostsIn(a.title)]);
    if (labels.size === 0 || a.sites.every(s => labels.has(s))) return;
    const action = this.report(C.Link, D.TextMismatch, this.loc(el), { element: el.qname, text: clip(a.text.trim(), 200), host: clip(a.sites.join(', '), 200) });
    this.ctx.memo.anchors.set(a.key, action);
  }

  /** Reads a noscript element's raw text again as markup, as a browser with scripting off reads it, and writes what passes. */
  private noscript(el: MarkupElement, frame: Frame): void {
    const text = (frame.noscript ?? []).join('');
    if (!text) return;
    const nested = new Rules(this.ctx, {
      html: true,
      keyPrefix: `${this.key(el)}>`,
      locPrefix: `${this.loc(el)} > `,
      lineOffset: el.line + this.opt.lineOffset - 1,
      writer: frame.write === 'all' ? this.writer : undefined,
      scripting: false,
    });
    readFragment(text, nested, this.ctx, false);
  }

  strayEnd(qname: string): void {
    this.writer?.strayEnd(qname);
  }

  text(text: string): void {
    const frame = this.frames[this.frames.length - 1];
    if (frame?.binData) this.collect(frame.binData, text);
    if (frame?.binReplace !== undefined) return;
    if (frame?.style) {
      this.collect(frame.style, text);
      return;
    }
    if (frame?.noscript) {
      this.collect(frame.noscript, text);
      return;
    }
    if (frame?.unescaped) this.collect(frame.unescaped, text);
    if (frame?.templateText) this.collect(frame.templateText, text);
    if (frame?.urlText) this.collect(frame.urlText, text);
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const a = this.frames[i].anchor;
      if (a) {
        if (a.text.length < 4096) a.text += text.slice(0, 4096 - a.text.length);
        break;
      }
    }
    const w = this.writer;
    if (!w) return;
    if (text.includes(UNKNOWN)) {
      // A reference to an external entity, which the tokenizer marks and the rewrite drops unless its finding says keep.
      const parts = text.split(UNKNOWN);
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) w.text(parts[i], frame?.raw);
        else if (this.keptEntities.has(parts[i])) w.entity(parts[i]);
      }
      return;
    }
    w.text(text, frame?.raw);
  }

  private readonly keptEntities = new Set<string>();

  /** A reference to an external entity in content, which the XML reading never fetches. */
  externalEntity(name: string, systemId: string, line: number): void {
    if (this.report(C.Xml, D.ExternalEntity, this.loc(line), { entity: clip(name, 60), target: clip(systemId, 300) }) !== 'strip') this.keptEntities.add(name);
  }

  /** Server code in the ASP and JSP form, which the HTML syntax reads as text. The rewrite escapes it whatever the action. */
  serverCode(line: number): void {
    this.report(C.Server, D.Code, this.loc(line), { kind: 'asp' });
  }

  private collect(into: string[], text: string): void {
    into.push(text);
    let n = 0;
    for (const t of into) n += t.length;
    if (n > this.ctx.tokenSize) {
      into.length = 0;
      into.push(text);
      throw new LimitText(this.ctx.tokenSize);
    }
  }

  comment(text: string, line: number, bogus: boolean): void {
    const loc = this.loc(line);
    if (SSI.test(text)) {
      if (this.report(C.Server, D.Ssi, loc, { directive: clip(text.trim(), 200) }) === 'strip') return;
    } else if (/^esi\s/.test(text)) {
      // An ESI processor reads what this comment holds as markup.
      if (this.report(C.Server, D.Esi, loc, { comment: clip(text, 200) }) === 'strip') return;
    } else if (bogus && /^\?(php\b|=|\s)/i.test(text)) {
      if (this.report(C.Server, D.Code, loc, { kind: 'php' }) === 'strip') return;
    }
    if (/^\s*\[(if\b|endif\])/i.test(text) || (!bogus && /<!\[endif\]\s*$/i.test(text))) {
      if (!bogus && this.ctx.findings) this.conditional(text, line);
      if (this.report(C.Format, D.ConditionalComment, loc, { comment: clip(text, 200) }) === 'strip') return;
    }
    if (!this.opt.html && !safeXmlComment(text)) {
      // Kept as written, it would end in another place for one of the readers, so it goes whatever an override says.
      this.report(C.Format, D.AmbiguousComment, loc, { comment: clip(text, 200) }, true);
      return;
    }
    if (this.ctx.stripMetadata) {
      this.ctx.metadataRemoved++;
      return;
    }
    if (this.styleDepth > 0) return;
    this.writer?.comment(text);
  }

  /** Reports what a conditional comment holds, which Internet Explorer and Outlook read as markup. */
  private conditional(text: string, line: number): void {
    const body = text.replace(/^\s*\[if[^\]]*\]>/i, '').replace(/<!\[endif\]\s*$/i, '');
    const nested = new Rules(this.ctx, { html: true, keyPrefix: `c${line}>`, locPrefix: `${this.loc(line)}, conditional comment > `, lineOffset: line - 1 });
    readFragment(body, nested, this.ctx);
  }

  instruction(target: string, data: string, line: number): void {
    const loc = this.loc(line);
    const lower = target.toLowerCase();
    if (lower === 'xml-stylesheet') {
      // An instruction whose pseudo-attributes do not read as the recommendation defines them can load anything.
      const pseudo = pseudoAttributes(data);
      const href = pseudo?.get('href') ?? '';
      const type = (pseudo?.get('type') ?? '').trim().toLowerCase();
      const clean = cleanUrl(href);
      if (!pseudo) {
        if (this.report(C.External, D.Stylesheet, loc, { target: clip(data, 300) }) === 'strip') return;
      } else if (clean !== '' && !clean.startsWith('#')) {
        // A CSS style sheet beside the page loads as a relative stylesheet link does. An XSLT transform is a program, so
        // it goes wherever it points, as an HTML import does.
        if (type === 'text/css' && this.besidePage(href)) {
          const trick = pathTrick(href);
          const action = trick ? this.report(C.External, D.PathTrick, loc, { target: clip(href, 300), reason: trick }) : this.report(C.External, D.Relative, loc, { target: clip(href, 300) });
          if (action === 'strip') return;
        } else if (this.report(C.External, D.Stylesheet, loc, { target: clip(href, 300) }) === 'strip') return;
      }
    } else if (lower === 'xml-model') {
      const pseudo = pseudoAttributes(data);
      const href = pseudo?.get('href') ?? '';
      const clean = cleanUrl(href);
      if (!pseudo) {
        if (this.report(C.Xml, D.SchemaLocation, loc, { target: clip(data, 300) }) === 'strip') return;
      } else if (clean !== '' && !clean.startsWith('#') && !onW3c(clean)) {
        if (this.besidePage(href)) {
          const trick = pathTrick(href);
          const action = trick ? this.report(C.External, D.PathTrick, loc, { target: clip(href, 300), reason: trick }) : this.report(C.External, D.Relative, loc, { target: clip(href, 300) });
          if (action === 'strip') return;
        } else if (this.report(C.Xml, D.SchemaLocation, loc, { target: clip(href, 300) }) === 'strip') return;
      }
    } else if (lower === 'php') {
      if (this.report(C.Server, D.Code, loc, { kind: 'php' }) === 'strip') return;
    } else if (this.ctx.stripMetadata) {
      this.ctx.metadataRemoved++;
      return;
    }
    if (data.includes('>')) {
      this.report(C.Format, D.AmbiguousInstruction, loc, { target: clip(target, 60) }, true);
      return;
    }
    this.writer?.instruction(target, data);
  }

  doctype(d: MarkupDoctype): void {
    const loc = this.loc(d.line);
    const ids: Record<string, string | number> = { name: clip(d.name ?? '', 60) };
    if (d.publicId !== undefined) ids.publicId = clip(d.publicId, 200);
    if (d.systemId !== undefined) ids.systemId = clip(d.systemId, 300);
    let keepIds = true;
    let keepSubset = true;
    if (d.subset !== undefined) keepSubset = this.report(C.Xml, D.InternalSubset, loc, { ...ids, entities: d.entities ?? 0, externalEntities: d.externalEntities ?? 0 }) !== 'strip';
    // A system identifier on www.w3.org names a standard DTD, and about:legacy-compat names none. An HTML reader
    // fetches neither, and an XML parser that loads external DTDs fetches the first. Any other one is checked in HTML
    // too, since an XML parser given the output would fetch it.
    const sys = d.systemId;
    const standard = sys === undefined || sys === 'about:legacy-compat' || onW3c(sys);
    if (!standard) keepIds = this.report(C.Xml, D.ExternalDtd, loc, ids) !== 'strip';
    // The declaration names no fetch of its own, so it goes only when an override strips it.
    if (!this.opt.html && d.subset === undefined && standard && this.report(C.Xml, D.Doctype, loc, ids) === 'strip') return;
    this.writer?.doctype(d, keepIds, keepSubset);
  }

  /** Checks a whole style sheet, such as the CSS part of an MHT file, and returns what the rewrite keeps. */
  sheet(css: string): string {
    const el: MarkupElement = { qname: 'style', local: 'style', ns: NS.html, attributes: [], namespaces: [], line: 1, empty: false, html: true, index: 0 };
    return filterCss(css, this.cssHooks(el, ''));
  }

  /** Whether the reading is HTML. */
  get html(): boolean {
    return this.opt.html;
  }
}

/** Raw text collected past the token size limit. */
export class LimitText extends Error {
  constructor(readonly limit: number) {
    super(`Raw text longer than ${limit} characters`);
  }
}

/** Whether a URL is an http or https one on www.w3.org, where the standard DTDs and schemas sit. */
function onW3c(url: string): boolean {
  if (/[<>"'\s]/.test(url)) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname === 'www.w3.org';
  } catch {
    return false;
  }
}

/** Cuts text from the file to a length that fits a finding's data. */
export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

/** Reads a piece of HTML, such as a noscript element's text, as markup in body content. */
export function readFragment(text: string, rules: Rules, ctx: RunCtx, scripting = true): void {
  const tree = new HtmlTree(rules, ctx.htmlDepth, scripting);
  const tokenizer = new HtmlTokenizer(tree, ctx.tokenSize);
  tree.attach(tokenizer);
  tokenizer.setState(ContentState.Data);
  tokenizer.write(text);
  tokenizer.end();
  tree.finish();
}
