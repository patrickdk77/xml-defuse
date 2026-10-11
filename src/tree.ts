import { StopError } from './errors';
import { ContentState, type HtmlAttribute, type HtmlDoctype, type HtmlTokenizer, type HtmlTokenSink } from './html';
import { type MarkupAttribute, type MarkupElement, NS, VOID_ELEMENTS } from './markup';
import { XmlCategory as C, XmlDetail as D } from './types';

export interface MarkupDoctype {
  name?: string;
  publicId?: string;
  systemId?: string;
  /** The internal subset of an XML document type declaration, as written. */
  subset?: string;
  /** Counts the XML tokenizer gives for the internal subset. */
  entities?: number;
  externalEntities?: number;
  line: number;
}

/** What either reading hands the rules, in document order. */
export interface MarkupHandler {
  start(el: MarkupElement): void;
  /** `explicit` when an end tag in the file closed the element, rather than another tag or the end of the file. */
  end(el: MarkupElement, explicit: boolean): void;
  /** An end tag that closes nothing, which an HTML reader ignores or reads as a tag of its own, such as </br> or </p>. */
  strayEnd(qname: string, line: number): void;
  text(text: string): void;
  comment(text: string, line: number, bogus: boolean): void;
  instruction(target: string, data: string, line: number): void;
  doctype(d: MarkupDoctype): void;
  serverCode(line: number): void;
}

const SVG_TAGS = new Map(
  [
    'altGlyph',
    'altGlyphDef',
    'altGlyphItem',
    'animateColor',
    'animateMotion',
    'animateTransform',
    'clipPath',
    'feBlend',
    'feColorMatrix',
    'feComponentTransfer',
    'feComposite',
    'feConvolveMatrix',
    'feDiffuseLighting',
    'feDisplacementMap',
    'feDistantLight',
    'feDropShadow',
    'feFlood',
    'feFuncA',
    'feFuncB',
    'feFuncG',
    'feFuncR',
    'feGaussianBlur',
    'feImage',
    'feMerge',
    'feMergeNode',
    'feMorphology',
    'feOffset',
    'fePointLight',
    'feSpecularLighting',
    'feSpotLight',
    'feTile',
    'feTurbulence',
    'foreignObject',
    'glyphRef',
    'linearGradient',
    'radialGradient',
    'textPath',
  ].map(n => [n.toLowerCase(), n]),
);

const SVG_ATTRIBUTES = new Map(
  [
    'attributeName',
    'attributeType',
    'baseFrequency',
    'baseProfile',
    'calcMode',
    'clipPathUnits',
    'diffuseConstant',
    'edgeMode',
    'filterUnits',
    'glyphRef',
    'gradientTransform',
    'gradientUnits',
    'kernelMatrix',
    'kernelUnitLength',
    'keyPoints',
    'keySplines',
    'keyTimes',
    'lengthAdjust',
    'limitingConeAngle',
    'markerHeight',
    'markerUnits',
    'markerWidth',
    'maskContentUnits',
    'maskUnits',
    'numOctaves',
    'pathLength',
    'patternContentUnits',
    'patternTransform',
    'patternUnits',
    'pointsAtX',
    'pointsAtY',
    'pointsAtZ',
    'preserveAlpha',
    'preserveAspectRatio',
    'primitiveUnits',
    'refX',
    'refY',
    'repeatCount',
    'repeatDur',
    'requiredExtensions',
    'requiredFeatures',
    'specularConstant',
    'specularExponent',
    'spreadMethod',
    'startOffset',
    'stdDeviation',
    'stitchTiles',
    'surfaceScale',
    'systemLanguage',
    'tableValues',
    'targetX',
    'targetY',
    'textLength',
    'viewBox',
    'viewTarget',
    'xChannelSelector',
    'yChannelSelector',
    'zoomAndPan',
  ].map(n => [n.toLowerCase(), n]),
);

/** Start tags that leave foreign content, as the rules for parsing tokens in foreign content list them. */
const BREAKOUT = new Set([
  'b',
  'big',
  'blockquote',
  'body',
  'br',
  'center',
  'code',
  'dd',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'hr',
  'i',
  'img',
  'li',
  'listing',
  'menu',
  'meta',
  'nobr',
  'ol',
  'p',
  'pre',
  'ruby',
  's',
  'small',
  'span',
  'strong',
  'strike',
  'sub',
  'sup',
  'table',
  'tt',
  'u',
  'ul',
  'var',
]);

/** HTML elements of the special category, where the search for an end tag's element stops. */
const SPECIAL = new Set(
  'address applet area article aside base basefont bgsound blockquote body br button caption center col colgroup dd details dir div dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input keygen li link listing main marquee menu meta nav noembed noframes noscript object ol p param plaintext pre script search section select source style summary table tbody td template textarea tfoot th thead title tr track ul wbr xmp'.split(
    ' ',
  ),
);

/** HTML elements that bound "in scope". */
const SCOPE = new Set(['applet', 'caption', 'html', 'table', 'td', 'th', 'marquee', 'object', 'template']);
/** HTML elements that bound "in table scope". */
const TABLE_SCOPE = new Set(['html', 'table', 'template']);
/** End tags the table insertion modes look for in table scope, closing the cells and rows open inside. */
const TABLE_ENDS = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup']);

/** Start tags that close an open p element. */
const CLOSES_P = new Set(
  'address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr listing main menu nav ol p plaintext pre search section summary table ul xmp'.split(
    ' ',
  ),
);

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const IMPLIED_END = new Set(['dd', 'dt', 'li', 'optgroup', 'option', 'p', 'rb', 'rp', 'rt', 'rtc']);
const FORMATTING = new Set(['a', 'b', 'big', 'code', 'em', 'font', 'i', 'nobr', 's', 'small', 'strike', 'strong', 'tt', 'u']);

const CONTENT_STATES = new Map<string, ContentState>([
  ['title', ContentState.Rcdata],
  ['textarea', ContentState.Rcdata],
  ['style', ContentState.Rawtext],
  ['xmp', ContentState.Rawtext],
  ['iframe', ContentState.Rawtext],
  ['noembed', ContentState.Rawtext],
  ['noframes', ContentState.Rawtext],
  ['noscript', ContentState.Rawtext],
  ['script', ContentState.ScriptData],
  ['plaintext', ContentState.Plaintext],
]);

/** An attribute of an element in foreign content, with the namespace the tree construction gives it. */
function foreignAttribute(a: HtmlAttribute, ns: string): MarkupAttribute {
  const name = a.name;
  if (name.startsWith('xlink:')) {
    const local = name.slice(6);
    if (['actuate', 'arcrole', 'href', 'role', 'show', 'title', 'type'].includes(local)) return { qname: name, local, ns: NS.xlink, value: a.value };
  }
  if (name === 'xml:lang' || name === 'xml:space') return { qname: name, local: name.slice(4), ns: NS.xml, value: a.value };
  if (name === 'xmlns') return { qname: name, local: 'xmlns', ns: NS.xmlns, value: a.value };
  if (name === 'xmlns:xlink') return { qname: name, local: 'xlink', ns: NS.xmlns, value: a.value };
  let adjusted = name;
  if (ns === NS.svg) adjusted = SVG_ATTRIBUTES.get(name) ?? name;
  else if (ns === NS.mathml && name === 'definitionurl') adjusted = 'definitionURL';
  return { qname: adjusted, local: adjusted, ns: '', value: a.value };
}

/**
 * The part of the HTML tree construction stage that decides how the tokenizer reads what follows: which elements are
 * open and in which namespace, when foreign content starts and ends, and which start tags switch the tokenizer to
 * raw text. It implies the common end tags, such as a <p> closed by a <div>, and does not build a tree. It hands
 * each element to the handler with its namespace, as a browser's parser would place it.
 */
export class HtmlTree implements HtmlTokenSink {
  private readonly stack: MarkupElement[] = [];
  private tokenizer?: HtmlTokenizer;
  private index = 0;

  constructor(
    private readonly handler: MarkupHandler,
    private readonly depthLimit: number,
    /** False reads as a browser with scripting off does, where a noscript element holds markup instead of raw text. */
    private readonly scripting = true,
  ) {}

  attach(tokenizer: HtmlTokenizer): void {
    this.tokenizer = tokenizer;
  }

  private current(): MarkupElement | undefined {
    return this.stack[this.stack.length - 1];
  }

  foreign(): boolean {
    const cur = this.current();
    return cur !== undefined && cur.ns !== NS.html;
  }

  private isHtmlIntegrationPoint(el: MarkupElement): boolean {
    if (el.ns === NS.svg) return el.local === 'foreignObject' || el.local === 'desc' || el.local === 'title';
    if (el.ns === NS.mathml && el.local === 'annotation-xml') {
      const enc = el.attributes.find(a => a.local === 'encoding')?.value.toLowerCase();
      return enc === 'text/html' || enc === 'application/xhtml+xml';
    }
    return false;
  }

  private isMathTextIntegrationPoint(el: MarkupElement): boolean {
    return el.ns === NS.mathml && ['mi', 'mo', 'mn', 'ms', 'mtext'].includes(el.local);
  }

  private pop(explicit: boolean): void {
    const el = this.stack.pop();
    if (el) this.handler.end(el, explicit);
  }

  /** Pops elements until `target` has been popped. The end tag closed `target` itself, and implied the others. */
  private popTo(target: MarkupElement, explicit: boolean): void {
    for (;;) {
      const el = this.current();
      if (!el) return;
      this.pop(el === target && explicit);
      if (el === target) return;
    }
  }

  private generateImpliedEnds(except?: string): void {
    for (;;) {
      const el = this.current();
      if (!el || el.ns !== NS.html || !IMPLIED_END.has(el.local) || el.local === except) return;
      this.pop(false);
    }
  }

  /** The topmost open HTML element with this name before a scope boundary, as "has an element in scope" looks. */
  private inScope(name: string, extra?: Set<string>, bounds = SCOPE): MarkupElement | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const el = this.stack[i];
      if (el.ns === NS.html && el.local === name) return el;
      if (el.ns === NS.html && (bounds.has(el.local) || extra?.has(el.local))) return undefined;
      if (el.ns !== NS.html && (this.isMathTextIntegrationPoint(el) || this.isHtmlIntegrationPoint(el) || (el.ns === NS.mathml && el.local === 'annotation-xml'))) return undefined;
    }
    return undefined;
  }

  private closeP(): void {
    const p = this.inScope('p', new Set(['button']));
    if (!p) return;
    this.generateImpliedEnds('p');
    this.popTo(p, false);
  }

  private element(qname: string, ns: string, attrs: MarkupAttribute[], line: number, empty: boolean): MarkupElement {
    return { qname, local: qname, ns, attributes: attrs, namespaces: [], line, empty, html: true, index: this.index++ };
  }

  private push(el: MarkupElement): void {
    if (this.stack.length >= this.depthLimit) throw new StopError(C.Limit, D.Depth, `Elements nest deeper than ${this.depthLimit}`, { limit: this.depthLimit }, `line ${el.line}`);
    this.stack.push(el);
  }

  start(rawName: string, attrs: HtmlAttribute[], selfClosing: boolean, line: number): void {
    const cur = this.current();
    let name = rawName;
    if (cur && cur.ns !== NS.html) {
      const htmlRules =
        (this.isMathTextIntegrationPoint(cur) && name !== 'mglyph' && name !== 'malignmark') ||
        (cur.ns === NS.mathml && cur.local === 'annotation-xml' && name === 'svg') ||
        this.isHtmlIntegrationPoint(cur);
      if (!htmlRules) {
        if (BREAKOUT.has(name) || (name === 'font' && attrs.some(a => a.name === 'color' || a.name === 'face' || a.name === 'size'))) {
          // The tag leaves foreign content and is read again as HTML.
          for (;;) {
            const top = this.current();
            if (!top || top.ns === NS.html || this.isMathTextIntegrationPoint(top) || this.isHtmlIntegrationPoint(top)) break;
            this.pop(false);
          }
        } else {
          const ns = cur.ns;
          const qname = ns === NS.svg ? (SVG_TAGS.get(name) ?? name) : name;
          const el = this.element(
            qname,
            ns,
            attrs.map(a => foreignAttribute(a, ns)),
            line,
            selfClosing,
          );
          this.handler.start(el);
          if (selfClosing) this.handler.end(el, true);
          else this.push(el);
          return;
        }
      }
    }
    if (name === 'svg' || name === 'math') {
      const ns = name === 'svg' ? NS.svg : NS.mathml;
      const el = this.element(
        name,
        ns,
        attrs.map(a => foreignAttribute(a, ns)),
        line,
        selfClosing,
      );
      this.handler.start(el);
      if (selfClosing) this.handler.end(el, true);
      else this.push(el);
      return;
    }
    if (name === 'image') name = 'img';
    this.impliedBy(name);
    const htmlAttrs = attrs.map(a => ({ qname: a.name, local: a.name, ns: '', value: a.value }));
    const isVoid = VOID_ELEMENTS.has(name);
    const el = this.element(name, NS.html, htmlAttrs, line, isVoid);
    // A second <html>, <head> or <body> adds its attributes to the open one instead of opening another.
    const merged = (name === 'html' || name === 'body' || name === 'head') && this.stack.some(e => e.ns === NS.html && e.local === name);
    this.handler.start(el);
    if (isVoid || merged) {
      this.handler.end(el, false);
      return;
    }
    this.push(el);
    const state = CONTENT_STATES.get(name);
    if (state !== undefined && (name !== 'noscript' || this.scripting)) this.tokenizer?.setState(state);
  }

  /** The end tags a start tag implies for the elements open before it. */
  private impliedBy(name: string): void {
    if (CLOSES_P.has(name)) this.closeP();
    const cur = this.current();
    if (HEADINGS.has(name) && cur && cur.ns === NS.html && HEADINGS.has(cur.local)) this.pop(false);
    if (name === 'li' || name === 'dd' || name === 'dt') {
      const closes = name === 'li' ? ['li'] : ['dd', 'dt'];
      for (let i = this.stack.length - 1; i >= 0; i--) {
        const el = this.stack[i];
        if (el.ns === NS.html && closes.includes(el.local)) {
          this.generateImpliedEnds(el.local);
          this.popTo(el, false);
          break;
        }
        if (el.ns !== NS.html || (SPECIAL.has(el.local) && el.local !== 'address' && el.local !== 'div' && el.local !== 'p')) break;
      }
      this.closeP();
    }
    if (name === 'button' || name === 'nobr' || name === 'a') {
      const open = name === 'a' ? [...this.stack].reverse().find(e => e.ns === NS.html && e.local === 'a') : this.inScope(name);
      if (open) this.popTo(open, false);
    }
    if (name === 'option' || name === 'optgroup') {
      if (this.current()?.local === 'option') this.pop(false);
      if (name === 'optgroup' && this.current()?.local === 'optgroup') this.pop(false);
    }
    if (name === 'td' || name === 'th' || name === 'tr' || name === 'tbody' || name === 'thead' || name === 'tfoot' || name === 'caption' || name === 'colgroup') {
      const closes = name === 'td' || name === 'th' ? ['td', 'th'] : name === 'tr' ? ['td', 'th', 'tr'] : ['td', 'th', 'tr', 'tbody', 'thead', 'tfoot', 'caption', 'colgroup'];
      // The outermost of them inside the current table goes, with what it holds: a row closes its open cell too.
      let target: MarkupElement | undefined;
      for (let i = this.stack.length - 1; i >= 0; i--) {
        const el = this.stack[i];
        if (el.ns !== NS.html || el.local === 'table' || el.local === 'template' || el.local === 'html') break;
        if (closes.includes(el.local)) target = el;
      }
      if (target) this.popTo(target, false);
    }
    if (name === 'rb' || name === 'rtc' || name === 'rp' || name === 'rt') {
      if (this.inScope('ruby')) this.generateImpliedEnds(name === 'rp' || name === 'rt' ? 'rtc' : undefined);
    }
    if (name === 'select' || name === 'input' || name === 'textarea' || name === 'keygen') {
      const select = this.inScope('select');
      if (select) this.popTo(select, false);
    }
  }

  end(name: string, line: number): void {
    const cur = this.current();
    if (cur && cur.ns !== NS.html) {
      if (name === 'br' || name === 'p') {
        for (;;) {
          const top = this.current();
          if (!top || top.ns === NS.html || this.isMathTextIntegrationPoint(top) || this.isHtmlIntegrationPoint(top)) break;
          this.pop(false);
        }
      } else {
        for (let i = this.stack.length - 1; i >= 0; i--) {
          const el = this.stack[i];
          if (el.ns === NS.html) break;
          if (el.local.toLowerCase() === name) {
            this.popTo(el, true);
            return;
          }
          if (i === 0) {
            this.handler.strayEnd(name, line);
            return;
          }
        }
      }
    }
    this.endHtml(name, line);
  }

  private endHtml(name: string, line: number): void {
    if (name === 'body' || name === 'html' || name === 'br') {
      this.handler.strayEnd(name, line);
      return;
    }
    if (name === 'form') {
      // The form element leaves the stack alone; whatever it holds stays open.
      const i = this.stack.map(e => e.ns === NS.html && e.local === 'form').lastIndexOf(true);
      if (i < 0) this.handler.strayEnd(name, line);
      else this.handler.end(this.stack.splice(i, 1)[0], true);
      return;
    }
    let target: MarkupElement | undefined;
    if (FORMATTING.has(name) || !SPECIAL.has(name)) {
      for (let i = this.stack.length - 1; i >= 0; i--) {
        const el = this.stack[i];
        if (el.ns === NS.html && el.local === name) {
          target = el;
          break;
        }
        if (el.ns === NS.html ? SPECIAL.has(el.local) : this.isHtmlIntegrationPoint(el) || this.isMathTextIntegrationPoint(el)) break;
      }
    } else if (HEADINGS.has(name)) {
      for (const h of HEADINGS) {
        const el = this.inScope(h);
        if (el && (!target || this.stack.indexOf(el) > this.stack.indexOf(target))) target = el;
      }
    } else if (TABLE_ENDS.has(name)) target = this.inScope(name, undefined, TABLE_SCOPE);
    else target = this.inScope(name, name === 'p' ? new Set(['button']) : name === 'li' ? new Set(['ol', 'ul']) : undefined);
    if (!target) {
      this.handler.strayEnd(name, line);
      return;
    }
    this.generateImpliedEnds(name);
    this.popTo(target, true);
  }

  text(text: string): void {
    this.handler.text(text);
  }

  comment(text: string, line: number, bogus: boolean): void {
    this.handler.comment(text, line, bogus);
  }

  doctype(d: HtmlDoctype, line: number): void {
    this.handler.doctype({ name: d.name, publicId: d.publicId, systemId: d.systemId, line });
  }

  serverTag(line: number): void {
    this.handler.serverCode(line);
  }

  /** Closes what is still open at the end of the file. */
  finish(): void {
    while (this.stack.length) this.pop(false);
  }
}
