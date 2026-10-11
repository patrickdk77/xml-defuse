import { escapeMarkupInCss } from './css';
import { type MarkupAttribute, type MarkupElement, NS, VOID_ELEMENTS } from './markup';
import type { MarkupDoctype } from './tree';

/** How the HTML syntax reads the text of the element it sits in. */
export type RawKind = 'style' | 'script' | 'rawtext' | 'rcdata' | undefined;

/** Collects output text, to be encoded as UTF-8 and handed to the sink between input chunks. */
export class OutputBuffer {
  private parts: string[] = [];
  private length = 0;
  write(s: string): void {
    if (!s) return;
    this.parts.push(s);
    this.length += s.length;
  }
  get pending(): number {
    return this.length;
  }
  take(): Buffer {
    const b = Buffer.from(this.parts.join(''), 'utf8');
    this.parts = [];
    this.length = 0;
    return b;
  }
}

/** Writes markup events in one syntax. */
export interface Writer {
  readonly html: boolean;
  doctype(d: MarkupDoctype, keepIds: boolean, keepSubset: boolean): void;
  start(el: MarkupElement, attrs: MarkupAttribute[]): void;
  end(el: MarkupElement): void;
  strayEnd(qname: string): void;
  text(t: string, raw: RawKind): void;
  comment(t: string): void;
  instruction(target: string, data: string): void;
  /** A reference to an external entity, kept as written. */
  entity(name: string): void;
}

/**
 * Text with the characters markup gives a meaning escaped. A carriage return, which only a character reference puts in
 * text, is written as one too, since a reader turns a written one into a line feed.
 */
const escapeText = (s: string) => s.replace(/[&<>\r]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&#13;'));

/** A quoted literal for a document type declaration, in the quotes it can be written in. */
const literal = (s: string) => (s.includes('"') ? `'${s}'` : `"${s}"`);

/**
 * The HTML syntax. Text and attribute values are escaped so that no text becomes markup for an HTML or an XML
 * reader. Raw text keeps its characters, except that a `<` an XML reader would take for a tag is escaped: as CSS in a
 * style sheet, and as a character reference elsewhere. The output starts with a UTF-8 byte order mark, which every
 * browser reads before any other encoding declaration. `html5` writes the HTML5 document type declaration first, in
 * place of any the document has, so a document that looked like XML is read as HTML again.
 */
export class HtmlWriter implements Writer {
  readonly html = true;
  constructor(
    private readonly out: OutputBuffer,
    private readonly html5 = false,
  ) {
    out.write('\uFEFF');
    if (html5) out.write('<!DOCTYPE html>');
  }

  doctype(d: MarkupDoctype, keepIds: boolean): void {
    if (this.html5) return;
    let s = '<!DOCTYPE';
    if (d.name !== undefined) s += ` ${d.name}`;
    if (keepIds && d.publicId !== undefined) s += ` PUBLIC ${literal(d.publicId)}${d.systemId !== undefined ? ` ${literal(d.systemId)}` : ''}`;
    else if (keepIds && d.systemId !== undefined) s += ` SYSTEM ${literal(d.systemId)}`;
    this.out.write(`${s}>`);
  }

  start(el: MarkupElement, attrs: MarkupAttribute[]): void {
    let s = `<${el.qname}`;
    for (const a of attrs) s += ` ${a.qname}="${escapeText(a.value).replace(/"/g, '&quot;')}"`;
    const foreign = el.ns !== NS.html;
    this.out.write(`${s}${foreign && el.empty ? '/>' : '>'}`);
  }

  end(el: MarkupElement): void {
    if (el.ns === NS.html && VOID_ELEMENTS.has(el.local)) return;
    if (el.ns !== NS.html && el.empty) return;
    this.out.write(`</${el.qname}>`);
  }

  strayEnd(qname: string): void {
    this.out.write(`</${qname}>`);
  }

  text(t: string, raw: RawKind): void {
    const s = t.replace(/\0/g, '');
    if (raw === 'script') this.out.write(s);
    else if (raw === 'style') this.out.write(escapeMarkupInCss(s));
    else if (raw === 'rawtext') this.out.write(s.replace(/<(?=[A-Za-z_:/\u0080-\uFFFF])/g, '&lt;'));
    else this.out.write(escapeText(s));
  }

  comment(t: string): void {
    this.out.write(`<!--${t}-->`);
  }

  instruction(): void {
    // The HTML syntax has none.
  }

  entity(): void {
    // The HTML syntax has none.
  }
}

/**
 * The XML syntax, in UTF-8. Each element declares the namespaces its start tag declared, and any binding it needs
 * that an element left out of the output declared, so the output stays namespace-well-formed. An empty XHTML element
 * that is not void in HTML gets an end tag, so an HTML reader does not leave it open.
 */
export class XmlWriter implements Writer {
  readonly html = false;
  private readonly scopes: Array<Map<string, string>> = [new Map([['xml', NS.xml]])];
  private depth = 0;

  constructor(
    private readonly out: OutputBuffer,
    declaration: { standalone: boolean } | undefined,
  ) {
    if (declaration) out.write(`<?xml version="1.0" encoding="UTF-8"${declaration.standalone ? ' standalone="yes"' : ''}?>\n`);
  }

  private bound(prefix: string): string {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const v = this.scopes[i].get(prefix);
      if (v !== undefined) return v;
    }
    return '';
  }

  doctype(d: MarkupDoctype, keepIds: boolean, keepSubset: boolean): void {
    let s = `<!DOCTYPE ${d.name ?? ''}`;
    if (keepIds && d.systemId !== undefined) s += d.publicId !== undefined ? ` PUBLIC ${literal(d.publicId)} ${literal(d.systemId)}` : ` SYSTEM ${literal(d.systemId)}`;
    if (keepSubset && d.subset !== undefined) s += ` [${d.subset}]`;
    this.out.write(`${s}>\n`);
  }

  start(el: MarkupElement, attrs: MarkupAttribute[]): void {
    const scope = new Map<string, string>();
    for (const [prefix, uri] of el.namespaces) scope.set(prefix, uri);
    const need = (prefix: string, uri: string) => {
      const have = scope.get(prefix) ?? this.bound(prefix);
      if (have !== uri) scope.set(prefix, uri);
    };
    const colon = el.qname.indexOf(':');
    need(colon < 0 ? '' : el.qname.slice(0, colon), el.ns);
    for (const a of attrs) {
      const c = a.qname.indexOf(':');
      if (c > 0) need(a.qname.slice(0, c), a.ns);
    }
    this.scopes.push(scope);
    let s = `<${el.qname}`;
    for (const [prefix, uri] of scope) {
      if (prefix === 'xml') continue;
      s += ` ${prefix === '' ? 'xmlns' : `xmlns:${prefix}`}="${escapeAttribute(uri)}"`;
    }
    for (const a of attrs) s += ` ${a.qname}="${escapeAttribute(a.value)}"`;
    if (el.empty && !(el.ns === NS.html && !VOID_ELEMENTS.has(el.local))) {
      this.scopes.pop();
      this.out.write(`${s}/>`);
      if (this.depth === 0) this.out.write('\n');
      return;
    }
    this.depth++;
    this.out.write(`${s}>`);
  }

  end(el: MarkupElement): void {
    if (el.empty && !(el.ns === NS.html && !VOID_ELEMENTS.has(el.local))) return;
    this.scopes.pop();
    this.depth--;
    this.out.write(`</${el.qname}>`);
    if (this.depth === 0) this.out.write('\n');
  }

  strayEnd(): void {
    // Well-formed XML has none.
  }

  text(t: string): void {
    this.out.write(escapeText(t));
  }

  comment(t: string): void {
    this.out.write(`<!--${t}-->`);
    if (this.depth === 0) this.out.write('\n');
  }

  instruction(target: string, data: string): void {
    this.out.write(`<?${target}${data ? ` ${data}` : ''}?>`);
    if (this.depth === 0) this.out.write('\n');
  }

  entity(name: string): void {
    this.out.write(`&${name};`);
  }
}

/** An XML attribute value: the characters XML would normalize away are written as references, so they survive. */
const escapeAttribute = (s: string) => escapeText(s).replace(/["\t\n\r]/g, c => (c === '"' ? '&quot;' : `&#${c.charCodeAt(0)};`));
