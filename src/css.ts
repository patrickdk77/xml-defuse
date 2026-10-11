import { XmlCategory as C, XmlDetail as D, type XmlFindingAction } from './types';
import { isRelativeUrl } from './url';

type TokType =
  | 'ws'
  | 'comment'
  | 'ident'
  | 'function'
  | 'at'
  | 'hash'
  | 'string'
  | 'badstring'
  | 'url'
  | 'badurl'
  | 'number'
  | 'delim'
  | 'cdo'
  | 'cdc'
  | '{'
  | '}'
  | '('
  | ')'
  | '['
  | ']'
  | ';'
  | ':'
  | ',';

interface Tok {
  type: TokType;
  start: number;
  end: number;
  /** The decoded name of an ident, function or at-keyword, the content of a string, or the target of a url token. */
  value: string;
  /** An escape stood in the name. */
  escaped: boolean;
}

/** What the rules decide for one URL in a style sheet. */
export type CssUrlDecision = 'keep' | 'drop' | { replace: string };

export interface CssHooks {
  /** Reports a finding and returns its action after any override. */
  report(category: C, detail: D, data?: Record<string, string | number>): XmlFindingAction;
  /** Classifies a URL a declaration or @import loads, reports it, and says what to do with it. */
  url(target: string): CssUrlDecision;
}

const isWsCode = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c;
const isHexCode = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isNameStart = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c >= 0x80;
const isNameCode = (c: number) => isNameStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d;
const isDigitCode = (c: number) => c >= 0x30 && c <= 0x39;

/** Properties that bind script or a component to elements. */
const BINDING_PROPERTIES = new Set(['behavior', '-ms-behavior', '-moz-binding', 'binding']);
/** Functions whose string arguments are URLs that load. */
const URL_FUNCTIONS = new Set(['url', 'src', 'image-set', '-webkit-image-set', 'image', 'cross-fade', '-webkit-cross-fade']);

class Lexer {
  private i = 0;
  constructor(private readonly s: string) {}

  private at(k = 0): number {
    const j = this.i + k;
    return j < this.s.length ? this.s.charCodeAt(j) : -1;
  }

  private validEscape(k = 0): boolean {
    return this.at(k) === 0x5c && this.at(k + 1) !== 0x0a && this.at(k + 1) !== 0x0c && this.at(k + 1) !== 0x0d;
  }

  private startsName(k = 0): boolean {
    const c = this.at(k);
    if (c === 0x2d) return isNameStart(this.at(k + 1)) || this.at(k + 1) === 0x2d || this.validEscape(k + 1);
    return isNameStart(c) || this.validEscape(k);
  }

  /** Consumes an escape after its backslash and returns the character it stands for. */
  private escape(): string {
    const c = this.at();
    if (c < 0) return '\uFFFD';
    if (isHexCode(c)) {
      let hex = '';
      while (hex.length < 6 && isHexCode(this.at())) {
        hex += this.s[this.i];
        this.i++;
      }
      if (isWsCode(this.at())) {
        if (this.at() === 0x0d && this.at(1) === 0x0a) this.i++;
        this.i++;
      }
      const code = Number.parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(code);
    }
    const ch = String.fromCodePoint(this.s.codePointAt(this.i) ?? 0xfffd);
    this.i += ch.length;
    return ch;
  }

  private name(): { value: string; escaped: boolean } {
    let value = '';
    let escaped = false;
    for (;;) {
      const c = this.at();
      if (isNameCode(c)) {
        value += this.s[this.i];
        this.i++;
      } else if (this.validEscape()) {
        this.i++;
        value += this.escape();
        escaped = true;
      } else return { value, escaped };
    }
  }

  next(): Tok | undefined {
    const s = this.s;
    const start = this.i;
    const c = this.at();
    if (c < 0) return undefined;
    const tok = (type: TokType, value = '', escaped = false): Tok => ({ type, start, end: this.i, value, escaped });
    if (c === 0x2f && this.at(1) === 0x2a) {
      const close = s.indexOf('*/', this.i + 2);
      this.i = close < 0 ? s.length : close + 2;
      return tok('comment');
    }
    if (isWsCode(c)) {
      while (isWsCode(this.at())) this.i++;
      return tok('ws');
    }
    if (c === 0x22 || c === 0x27) {
      this.i++;
      let value = '';
      for (;;) {
        const d = this.at();
        if (d === c) {
          this.i++;
          return tok('string', value);
        }
        if (d < 0) return tok('string', value);
        if (d === 0x0a || d === 0x0c || d === 0x0d) return tok('badstring', value);
        if (d === 0x5c) {
          const e = this.at(1);
          if (e < 0) this.i++;
          else if (e === 0x0a || e === 0x0c || e === 0x0d) this.i += e === 0x0d && this.at(2) === 0x0a ? 3 : 2;
          else {
            this.i++;
            value += this.escape();
          }
        } else {
          value += s[this.i];
          this.i++;
        }
      }
    }
    if (c === 0x23) {
      this.i++;
      if (isNameCode(this.at()) || this.validEscape()) {
        const n = this.name();
        return tok('hash', n.value, n.escaped);
      }
      return tok('delim', '#');
    }
    if (c === 0x40) {
      this.i++;
      if (this.startsName()) {
        const n = this.name();
        return tok('at', n.value.toLowerCase(), n.escaped);
      }
      return tok('delim', '@');
    }
    if (c === 0x3c && s.startsWith('<!--', this.i)) {
      this.i += 4;
      return tok('cdo');
    }
    if (c === 0x2d && s.startsWith('-->', this.i)) {
      this.i += 3;
      return tok('cdc');
    }
    if (isDigitCode(c) || ((c === 0x2b || c === 0x2d || c === 0x2e) && (isDigitCode(this.at(1)) || (this.at(1) === 0x2e && isDigitCode(this.at(2)))))) {
      this.i++;
      while (isDigitCode(this.at()) || this.at() === 0x2e) this.i++;
      if ((this.at() === 0x65 || this.at() === 0x45) && (isDigitCode(this.at(1)) || ((this.at(1) === 0x2b || this.at(1) === 0x2d) && isDigitCode(this.at(2))))) {
        this.i += 2;
        while (isDigitCode(this.at())) this.i++;
      }
      if (this.startsName()) this.name();
      else if (this.at() === 0x25) this.i++;
      return tok('number');
    }
    if (this.startsName()) {
      const n = this.name();
      if (this.at() !== 0x28) return tok('ident', n.value, n.escaped);
      this.i++;
      const lowered = n.value.toLowerCase();
      if (lowered !== 'url') return tok('function', lowered, n.escaped);
      while (isWsCode(this.at())) this.i++;
      if (this.at() === 0x22 || this.at() === 0x27) return tok('function', 'url', n.escaped);
      return this.urlToken(start, n.escaped);
    }
    this.i++;
    if (c === 0x5c) return tok('delim', '\\');
    const single: Record<string, TokType> = { '{': '{', '}': '}', '(': '(', ')': ')', '[': '[', ']': ']', ';': ';', ':': ':', ',': ',' };
    const ch = s[start];
    return Object.hasOwn(single, ch) ? tok(single[ch]) : tok('delim', ch);
  }

  /** The rest of an unquoted url( ... ) token. */
  private urlToken(start: number, escaped: boolean): Tok {
    let value = '';
    for (;;) {
      const c = this.at();
      if (c < 0) return { type: 'url', start, end: this.i, value, escaped };
      if (c === 0x29) {
        this.i++;
        return { type: 'url', start, end: this.i, value, escaped };
      }
      if (isWsCode(c)) {
        while (isWsCode(this.at())) this.i++;
        if (this.at() === 0x29 || this.at() < 0) continue;
        return this.badUrl(start, value);
      }
      if (c === 0x22 || c === 0x27 || c === 0x28 || c < 0x09 || c === 0x0b || (c > 0x0d && c < 0x20) || c === 0x7f) return this.badUrl(start, value);
      if (c === 0x5c) {
        if (!this.validEscape()) return this.badUrl(start, value);
        this.i++;
        value += this.escape();
      } else {
        value += this.s[this.i];
        this.i++;
      }
    }
  }

  /** Skips to the ")" that ends a bad url token, over escapes. */
  private badUrl(start: number, value: string): Tok {
    for (;;) {
      const c = this.at();
      if (c < 0) break;
      this.i++;
      if (c === 0x29) break;
      if (c === 0x5c && this.at() >= 0) this.i++;
    }
    return { type: 'badurl', start, end: this.i, value, escaped: false };
  }
}

function tokenize(css: string): Tok[] {
  const lexer = new Lexer(css);
  const out: Tok[] = [];
  for (let t = lexer.next(); t; t = lexer.next()) out.push(t);
  return out;
}

/** A declaration's text with comments gone and escapes read, as older Internet Explorer matched expression() in it. */
function normalized(css: string): string {
  let out = '';
  const lexer = new Lexer(css);
  for (let t = lexer.next(); t; t = lexer.next()) {
    if (t.type === 'comment') continue;
    if (t.type === 'ident' || t.type === 'function' || t.type === 'at' || t.type === 'hash')
      out += (t.type === 'at' ? '@' : t.type === 'hash' ? '#' : '') + t.value + (t.type === 'function' ? '(' : '');
    else if (t.type === 'url') out += `url(${t.value})`;
    else out += css.slice(t.start, t.end);
  }
  return out.normalize('NFKC').toLowerCase();
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** A CSS string literal holding `s`. */
const cssString = (s: string) => `"${s.replace(/[\\"]/g, m => `\\${m}`).replace(/[\n\r\f]/g, m => `\\${m.charCodeAt(0).toString(16)} `)}"`;

/**
 * Checks a style sheet, or the declarations of a style attribute, and returns it with every declaration or at-rule a
 * strip finding names removed. A data: URL a plugin rewrote is replaced in place. The rest of the text is kept as
 * written.
 */
export function filterCss(css: string, hooks: CssHooks): string {
  const toks = tokenize(css);
  const edits: Edit[] = [];
  let escapedReported = false;
  const noteEscapes = (from: number, to: number) => {
    if (escapedReported) return;
    for (let k = from; k < to; k++) {
      const t = toks[k];
      if (t.escaped && (t.type === 'ident' || t.type === 'function' || t.type === 'at')) {
        escapedReported = true;
        hooks.report(C.Style, D.Escaped, { name: t.value.slice(0, 60) });
        return;
      }
    }
  };

  /**
   * Checks the URLs in toks[from, to), and returns whether the span has to go, with any replacements. `leadingString`
   * reads a string that comes first as a URL too, as @import does.
   */
  const urls = (from: number, to: number, leadingString = false): { drop: boolean; replace: Edit[]; targets: string[] } => {
    const replace: Edit[] = [];
    const targets: string[] = [];
    let drop = false;
    const decide = (target: string, tok: Tok, quoted: boolean) => {
      targets.push(target);
      const d = hooks.url(target);
      if (d === 'drop') drop = true;
      else if (d !== 'keep') replace.push({ start: tok.start, end: tok.end, text: quoted ? cssString(d.replace) : `url(${cssString(d.replace)})` });
    };
    if (leadingString) {
      const first = toks.slice(from, to).find(t => t.type !== 'ws' && t.type !== 'comment');
      if (first?.type === 'string') decide(first.value, first, true);
    }
    for (let k = from; k < to; k++) {
      const t = toks[k];
      if (t.type === 'url') decide(t.value, t, false);
      else if (t.type === 'badurl') {
        // A browser drops the declaration, but an older reader may load what it names, so the target is checked.
        decide(
          css
            .slice(t.start, t.end)
            .replace(/^[^(]*\(\s*/, '')
            .replace(/\)$/, '')
            .trim(),
          t,
          false,
        );
      } else if (t.type === 'function' && URL_FUNCTIONS.has(t.value)) {
        // Every string argument of these functions is a URL.
        let depth = 0;
        for (let m = k + 1; m < to; m++) {
          const u = toks[m];
          if (u.type === '(' || u.type === 'function') depth++;
          else if (u.type === ')') {
            if (depth === 0) break;
            depth--;
          } else if (u.type === 'string' && depth === 0) decide(u.value, u, true);
        }
      }
    }
    return { drop, replace, targets };
  };

  /** Checks one declaration in toks[from, to), whose text ends at `end`. */
  const declaration = (from: number, to: number, end: number) => {
    let k = from;
    while (k < to && (toks[k].type === 'ws' || toks[k].type === 'comment')) k++;
    if (k >= to) return;
    const start = toks[k].start;
    const name = toks[k].type === 'ident' ? toks[k].value.toLowerCase() : '';
    noteEscapes(k, to);
    let drop = false;
    if (BINDING_PROPERTIES.has(name) && hooks.report(C.Style, D.Binding, { property: name }) === 'strip') drop = true;
    const text = normalized(css.slice(start, end));
    if (/expression\s*\(/.test(text) && hooks.report(C.Style, D.Expression, { property: name }) === 'strip') drop = true;
    if (text.includes('progid:') && hooks.report(C.Style, D.Binding, { property: name, kind: 'progid' }) === 'strip') drop = true;
    const u = urls(k, to);
    if (u.drop || drop) edits.push({ start, end, text: '' });
    else edits.push(...u.replace);
  };

  /**
   * Walks the rules and declarations in order. A block's contents are walked like the sheet itself, so nested rules and
   * the declarations of a rule are checked alike, and a closing brace only ends the block it closes.
   */
  const walk = (): void => {
    let i = 0;
    while (i < toks.length) {
      const t = toks[i];
      if (t.type === 'ws' || t.type === 'comment' || t.type === ';' || t.type === 'cdo' || t.type === 'cdc' || t.type === '}') {
        i++;
        continue;
      }
      // Up to the first ";" or "{" outside parentheses and brackets, or the "}" that closes the block.
      let j = i;
      let depth = 0;
      for (; j < toks.length; j++) {
        const u = toks[j].type;
        if (u === '(' || u === '[' || u === 'function') depth++;
        else if ((u === ')' || u === ']') && depth > 0) depth--;
        else if (depth === 0 && (u === ';' || u === '{' || u === '}')) break;
      }
      const stop = j < toks.length ? toks[j].type : '';
      if (t.type === 'at') {
        noteEscapes(i, i + 1);
        if (t.value === 'import') {
          const end = stop === ';' ? toks[j].end : j < toks.length ? toks[j].start : css.length;
          const u = urls(i + 1, j, true);
          // A style sheet beside the page, at a relative address, is imported as a web page imports it.
          const besidePage = u.targets.length > 0 && u.targets.every(isRelativeUrl);
          const imported = besidePage ? 'info' : hooks.report(C.Style, D.Import, {});
          if (imported === 'strip' || u.drop) edits.push({ start: t.start, end, text: '' });
          else edits.push(...u.replace);
        }
        i = stop === ';' || stop === '{' ? j + 1 : j;
        continue;
      }
      if (stop === '{') {
        // A rule: its selector loads nothing, and its block holds declarations and nested rules.
        i = j + 1;
        continue;
      }
      const end = stop === ';' ? toks[j].end : j < toks.length ? toks[j].start : css.length;
      // A declaration, or at the top of a style sheet text that browsers drop as a broken rule. Both are checked.
      declaration(i, j, end);
      i = stop === ';' ? j + 1 : j;
    }
  };

  walk();
  if (!edits.length) return css;
  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const e of edits) {
    if (e.start < at) continue;
    out += css.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + css.slice(at);
}

/**
 * Writes a `<` that starts what an XML reader would take for a tag as the CSS escape `\3c `, so a style sheet in HTML
 * raw text holds no markup for another reader. A `<` before a space or a digit stays.
 */
export function escapeMarkupInCss(css: string): string {
  return css.replace(/<(?=[A-Za-z_:/\u0080-\uFFFF])/g, '\\3c ');
}
