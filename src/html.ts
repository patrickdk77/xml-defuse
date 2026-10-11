import { LONGEST_REFERENCE, NAMED_REFERENCES } from './entities';
import { StopError } from './errors';
import { XmlCategory as C, XmlDetail as D } from './types';

export interface HtmlAttribute {
  /** Lowercased, as the tokenizer gives it. */
  name: string;
  value: string;
}

export interface HtmlDoctype {
  name?: string;
  publicId?: string;
  systemId?: string;
  forceQuirks: boolean;
}

/** What the tokenizer emits. The tree model sits behind it and switches its state after some start tags. */
export interface HtmlTokenSink {
  start(name: string, attrs: HtmlAttribute[], selfClosing: boolean, line: number): void;
  end(name: string, line: number): void;
  /** Text with its character references decoded, in pieces of any size. Raw text and CDATA sections come as text too. */
  text(text: string): void;
  /** `bogus` marks what the tokenizer reads as a comment although it is not one, such as `<?php ... ?>` or `<!x>`. */
  comment(text: string, line: number, bogus: boolean): void;
  doctype(d: HtmlDoctype, line: number): void;
  /** A "<%" that opens server code in the ASP and JSP form, which HTML reads as text. */
  serverTag(line: number): void;
  /** Whether the adjusted current node is outside the HTML namespace, which decides whether `<![CDATA[` opens a section. */
  foreign(): boolean;
}

/** The content states the tree model switches to after a start tag. */
export enum ContentState {
  Data = 0,
  Rcdata = 1,
  Rawtext = 2,
  ScriptData = 3,
  Plaintext = 4,
}

// The tokenizer states of the WHATWG HTML Standard, section 13.2.5. The first five match ContentState.
enum S {
  Data = 0,
  Rcdata = 1,
  Rawtext = 2,
  Script = 3,
  Plaintext = 4,
  TagOpen = 5,
  EndTagOpen = 6,
  TagName = 7,
  RcdataLt = 8,
  RcdataEndOpen = 9,
  RcdataEndName = 10,
  RawtextLt = 11,
  RawtextEndOpen = 12,
  RawtextEndName = 13,
  ScriptLt = 14,
  ScriptEndOpen = 15,
  ScriptEndName = 16,
  ScriptEscStart = 17,
  ScriptEscStartDash = 18,
  ScriptEsc = 19,
  ScriptEscDash = 20,
  ScriptEscDashDash = 21,
  ScriptEscLt = 22,
  ScriptEscEndOpen = 23,
  ScriptEscEndName = 24,
  ScriptDescStart = 25,
  ScriptDesc = 26,
  ScriptDescDash = 27,
  ScriptDescDashDash = 28,
  ScriptDescLt = 29,
  ScriptDescEnd = 30,
  BeforeAttrName = 31,
  AttrName = 32,
  AfterAttrName = 33,
  BeforeAttrValue = 34,
  AttrValueDq = 35,
  AttrValueSq = 36,
  AttrValueUq = 37,
  AfterAttrValueQ = 38,
  SelfClosing = 39,
  BogusComment = 40,
  MarkupDecl = 41,
  CommentStart = 42,
  CommentStartDash = 43,
  Comment = 44,
  CommentLt = 45,
  CommentLtBang = 46,
  CommentLtBangDash = 47,
  CommentLtBangDashDash = 48,
  CommentEndDash = 49,
  CommentEnd = 50,
  CommentEndBang = 51,
  Doctype = 52,
  BeforeDoctypeName = 53,
  DoctypeName = 54,
  AfterDoctypeName = 55,
  AfterDoctypePublicKw = 56,
  BeforeDoctypePublicId = 57,
  DoctypePublicIdDq = 58,
  DoctypePublicIdSq = 59,
  AfterDoctypePublicId = 60,
  BetweenDoctypeIds = 61,
  AfterDoctypeSystemKw = 62,
  BeforeDoctypeSystemId = 63,
  DoctypeSystemIdDq = 64,
  DoctypeSystemIdSq = 65,
  AfterDoctypeSystemId = 66,
  BogusDoctype = 67,
  Cdata = 68,
  CdataBracket = 69,
  CdataEnd = 70,
  CharRef = 71,
  NamedRef = 72,
  NumericRef = 73,
  HexRefStart = 74,
  DecRefStart = 75,
  HexRef = 76,
  DecRef = 77,
  NumericRefEnd = 78,
}

const EOF = -1;
const REPLACEMENT = '\uFFFD';

/** What a numeric reference to a C1 control code stands for: the windows-1252 character at that byte. */
const C1_REPLACEMENTS = new Map<number, number>([
  [0x80, 0x20ac],
  [0x82, 0x201a],
  [0x83, 0x0192],
  [0x84, 0x201e],
  [0x85, 0x2026],
  [0x86, 0x2020],
  [0x87, 0x2021],
  [0x88, 0x02c6],
  [0x89, 0x2030],
  [0x8a, 0x0160],
  [0x8b, 0x2039],
  [0x8c, 0x0152],
  [0x8e, 0x017d],
  [0x91, 0x2018],
  [0x92, 0x2019],
  [0x93, 0x201c],
  [0x94, 0x201d],
  [0x95, 0x2022],
  [0x96, 0x2013],
  [0x97, 0x2014],
  [0x98, 0x02dc],
  [0x99, 0x2122],
  [0x9a, 0x0161],
  [0x9b, 0x203a],
  [0x9c, 0x0153],
  [0x9e, 0x017e],
  [0x9f, 0x0178],
]);

const isWs = (c: number) => c === 0x09 || c === 0x0a || c === 0x0c || c === 0x20;
const isUpper = (c: number) => c >= 0x41 && c <= 0x5a;
const isLower = (c: number) => c >= 0x61 && c <= 0x7a;
const isAlpha = (c: number) => isUpper(c) || isLower(c);
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isAlnum = (c: number) => isAlpha(c) || isDigit(c);
const isHex = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const lower = (c: number) => String.fromCharCode(isUpper(c) ? c + 0x20 : c);

/** The text a numeric character reference stands for, as the numeric character reference end state decides it. */
function numericText(code: number): string {
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return REPLACEMENT;
  return String.fromCodePoint(C1_REPLACEMENTS.get(code) ?? code);
}

/**
 * A streaming HTML tokenizer that follows the tokenization states of the WHATWG HTML Standard (13.2.5), character
 * references included. Input arrives as decoded text in pieces; line ends are normalized as the input stream
 * preprocessing says. The tree model behind the sink switches the content state after start tags such as <style> and
 * <script>, and tells it whether CDATA sections are allowed. Each tag, comment and document type declaration is held
 * whole, up to `tokenSize` characters. Text goes to the sink in pieces.
 */
export class HtmlTokenizer {
  private buf = '';
  private pos = 0;
  private final = false;
  private state = S.Data;
  private returnState = S.Data;
  private lastCr = false;
  private pendingText = '';
  // The token being built.
  private tagName = '';
  private isEndTag = false;
  private selfClosing = false;
  private attrs: HtmlAttribute[] = [];
  /** The names in attrs, so a tag with many attributes is not checked in quadratic time. */
  private attrNames = new Set<string>();
  private inAttr = false;
  private attrName = '';
  private attrValue = '';
  private comment = '';
  private bogus = false;
  private doc: HtmlDoctype = { forceQuirks: false };
  private tempBuf = '';
  private refCode = 0;
  private lastStartTag = '';
  private tokenChars = 0;
  private tokenLine = 1;
  // Lines: a cursor in buf and the line it is on, which counts forward.
  private lineIdx = 0;
  private lineAtIdx = 1;
  /** The first line feed in buf at or after lineIdx, -1 for none, undefined until looked for. */
  private nextLf?: number;

  constructor(
    private readonly sink: HtmlTokenSink,
    private readonly tokenSize: number,
  ) {}

  /** Switches the content state, as the tree model does after a start tag. */
  setState(state: ContentState): void {
    this.state = state as number as S;
  }

  write(text: string): void {
    this.feed(text, false);
  }

  end(): void {
    this.feed('', true);
  }

  private feed(text: string, final: boolean): void {
    let t = text;
    if (this.lastCr && t.charCodeAt(0) === 0x0a) t = t.slice(1);
    if (t.length) this.lastCr = t.charCodeAt(t.length - 1) === 0x0d;
    if (t.includes('\r')) t = t.replace(/\r\n?/g, '\n');
    const line = this.lineAt(this.pos);
    this.buf = this.buf.slice(this.pos) + t;
    this.pos = 0;
    this.lineIdx = 0;
    this.lineAtIdx = line;
    this.nextLf = undefined;
    this.final = final;
    this.run();
    this.flushText();
  }

  /** The line of buf[i]. Positions come in order, and the next line feed is remembered, so a long line is searched once. */
  private lineAt(i: number): number {
    if (i <= this.lineIdx) return this.lineAtIdx;
    let at = this.nextLf ?? this.buf.indexOf('\n', this.lineIdx);
    for (; at >= 0 && at < i; at = this.buf.indexOf('\n', at + 1)) this.lineAtIdx++;
    this.nextLf = at;
    this.lineIdx = i;
    return this.lineAtIdx;
  }

  private emitText(s: string): void {
    this.pendingText += s;
    if (this.pendingText.length >= 65536) this.flushText();
  }

  private flushText(): void {
    if (!this.pendingText) return;
    const t = this.pendingText;
    this.pendingText = '';
    this.sink.text(t);
  }

  private grow(n = 1): void {
    this.tokenChars += n;
    if (this.tokenChars > this.tokenSize) throw new StopError(C.Limit, D.TokenSize, `A token is longer than ${this.tokenSize} characters`, { limit: this.tokenSize }, `line ${this.tokenLine}`);
  }

  private beginToken(): void {
    this.tokenChars = 0;
    this.tokenLine = this.lineAt(this.pos);
  }

  private newTag(end: boolean): void {
    this.isEndTag = end;
    this.tagName = '';
    this.selfClosing = false;
    this.attrs = [];
    this.attrNames = new Set();
    this.inAttr = false;
    this.attrName = '';
    this.attrValue = '';
  }

  /** Ends the attribute being read. A second attribute of the same name is dropped, as the standard says. */
  private finishAttr(): void {
    if (!this.inAttr) return;
    this.inAttr = false;
    if (!this.attrNames.has(this.attrName)) {
      this.attrNames.add(this.attrName);
      this.attrs.push({ name: this.attrName, value: this.attrValue });
    }
    this.attrName = '';
    this.attrValue = '';
  }

  private startAttr(): void {
    this.finishAttr();
    this.inAttr = true;
    this.attrName = '';
    this.attrValue = '';
  }

  private emitTag(): void {
    this.finishAttr();
    this.flushText();
    if (this.isEndTag) this.sink.end(this.tagName, this.tokenLine);
    else {
      this.lastStartTag = this.tagName;
      this.sink.start(this.tagName, this.attrs, this.selfClosing, this.tokenLine);
    }
  }

  private emitComment(): void {
    this.flushText();
    this.sink.comment(this.comment, this.tokenLine, this.bogus);
  }

  private emitDoctype(): void {
    this.flushText();
    this.sink.doctype(this.doc, this.tokenLine);
  }

  private appropriate(): boolean {
    return this.tagName === this.lastStartTag && this.lastStartTag !== '';
  }

  /** Where a character reference's text goes: the attribute value, or the text. */
  private flushRef(s: string): void {
    if (this.returnState === S.AttrValueDq || this.returnState === S.AttrValueSq || this.returnState === S.AttrValueUq) {
      this.attrValue += s;
      this.grow(s.length);
    } else this.emitText(s);
  }

  private inAttribute(): boolean {
    return this.returnState === S.AttrValueDq || this.returnState === S.AttrValueSq || this.returnState === S.AttrValueUq;
  }

  /** Copies plain characters of the current state in one slice, up to the first one that needs a state of its own. */
  private run(): void {
    for (;;) {
      const b = this.buf;
      if (this.pos > b.length) this.pos = b.length;
      const at = this.pos;
      const atEnd = at >= b.length;
      if (atEnd && !this.final) return;
      const c = atEnd ? EOF : b.charCodeAt(at);
      if (!this.step(c, b, at)) return;
    }
  }

  /** Reads one character in the current state. Returns false when the input has ended or more is needed. */
  private step(c: number, b: string, at: number): boolean {
    switch (this.state) {
      case S.Data:
      case S.Rcdata: {
        if (c === EOF) return false;
        if (c === 0x26) {
          this.returnState = this.state;
          this.state = S.CharRef;
          this.pos++;
          return true;
        }
        if (c === 0x3c) {
          this.state = this.state === S.Data ? S.TagOpen : S.RcdataLt;
          this.beginToken();
          this.pos++;
          return true;
        }
        if (c === 0) {
          // The tree model drops a NUL in data; RCDATA turns it into U+FFFD.
          this.emitText(this.state === S.Data ? '\0' : REPLACEMENT);
          this.pos++;
          return true;
        }
        let e = at + 1;
        while (e < b.length) {
          const d = b.charCodeAt(e);
          if (d === 0x26 || d === 0x3c || d === 0) break;
          e++;
        }
        this.emitText(b.slice(at, e));
        this.pos = e;
        return true;
      }
      case S.Rawtext:
      case S.Script:
      case S.Plaintext: {
        if (c === EOF) return false;
        if (c === 0x3c && this.state !== S.Plaintext) {
          this.state = this.state === S.Rawtext ? S.RawtextLt : S.ScriptLt;
          this.beginToken();
          this.pos++;
          return true;
        }
        if (c === 0) {
          this.emitText(REPLACEMENT);
          this.pos++;
          return true;
        }
        let e = at + 1;
        while (e < b.length) {
          const d = b.charCodeAt(e);
          if ((d === 0x3c && this.state !== S.Plaintext) || d === 0) break;
          e++;
        }
        this.emitText(b.slice(at, e));
        this.pos = e;
        return true;
      }
      case S.TagOpen:
        if (c === 0x21) {
          this.state = S.MarkupDecl;
          this.pos++;
        } else if (c === 0x2f) {
          this.state = S.EndTagOpen;
          this.pos++;
        } else if (isAlpha(c)) {
          this.newTag(false);
          this.state = S.TagName;
        } else if (c === 0x3f) {
          this.comment = '';
          this.bogus = true;
          this.state = S.BogusComment;
        } else if (c === EOF) {
          this.emitText('<');
          return false;
        } else {
          if (c === 0x25) this.sink.serverTag(this.tokenLine);
          this.emitText('<');
          this.state = S.Data;
        }
        return true;
      case S.EndTagOpen:
        if (isAlpha(c)) {
          this.newTag(true);
          this.state = S.TagName;
        } else if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
        } else if (c === EOF) {
          this.emitText('</');
          return false;
        } else {
          this.comment = '';
          this.bogus = true;
          this.state = S.BogusComment;
        }
        return true;
      case S.TagName:
        if (isWs(c)) {
          this.state = S.BeforeAttrName;
          this.pos++;
        } else if (c === 0x2f) {
          this.state = S.SelfClosing;
          this.pos++;
        } else if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
          this.emitTag();
        } else if (c === EOF) return false;
        else {
          let e = at;
          let name = '';
          while (e < b.length) {
            const d = b.charCodeAt(e);
            if (isWs(d) || d === 0x2f || d === 0x3e) break;
            name += d === 0 ? REPLACEMENT : lower(d);
            e++;
          }
          this.tagName += name;
          this.grow(name.length);
          this.pos = e;
        }
        return true;
      case S.RcdataLt:
      case S.RawtextLt:
        if (c === 0x2f) {
          this.tempBuf = '';
          this.state = this.state === S.RcdataLt ? S.RcdataEndOpen : S.RawtextEndOpen;
          this.pos++;
        } else {
          this.emitText('<');
          this.state = this.state === S.RcdataLt ? S.Rcdata : S.Rawtext;
        }
        return true;
      case S.RcdataEndOpen:
      case S.RawtextEndOpen:
      case S.ScriptEndOpen:
      case S.ScriptEscEndOpen: {
        const back = this.state === S.RcdataEndOpen ? S.Rcdata : this.state === S.RawtextEndOpen ? S.Rawtext : this.state === S.ScriptEndOpen ? S.Script : S.ScriptEsc;
        if (isAlpha(c)) {
          this.newTag(true);
          this.state = this.state === S.RcdataEndOpen ? S.RcdataEndName : this.state === S.RawtextEndOpen ? S.RawtextEndName : this.state === S.ScriptEndOpen ? S.ScriptEndName : S.ScriptEscEndName;
        } else {
          this.emitText('</');
          this.state = back;
        }
        return true;
      }
      case S.RcdataEndName:
      case S.RawtextEndName:
      case S.ScriptEndName:
      case S.ScriptEscEndName: {
        const back = this.state === S.RcdataEndName ? S.Rcdata : this.state === S.RawtextEndName ? S.Rawtext : this.state === S.ScriptEndName ? S.Script : S.ScriptEsc;
        if ((isWs(c) || c === 0x2f || c === 0x3e) && this.appropriate()) {
          this.pos++;
          if (c === 0x3e) {
            this.state = S.Data;
            this.emitTag();
          } else this.state = c === 0x2f ? S.SelfClosing : S.BeforeAttrName;
        } else if (isAlpha(c)) {
          this.tagName += lower(c);
          this.tempBuf += String.fromCharCode(c);
          this.grow();
          this.pos++;
        } else {
          this.emitText(`</${this.tempBuf}`);
          this.state = back;
        }
        return true;
      }
      case S.ScriptLt:
        if (c === 0x2f) {
          this.tempBuf = '';
          this.state = S.ScriptEndOpen;
          this.pos++;
        } else if (c === 0x21) {
          this.state = S.ScriptEscStart;
          this.emitText('<!');
          this.pos++;
        } else {
          this.emitText('<');
          this.state = S.Script;
        }
        return true;
      case S.ScriptEscStart:
      case S.ScriptEscStartDash:
        if (c === 0x2d) {
          this.state = this.state === S.ScriptEscStart ? S.ScriptEscStartDash : S.ScriptEscDashDash;
          this.emitText('-');
          this.pos++;
        } else this.state = S.Script;
        return true;
      case S.ScriptEsc:
      case S.ScriptEscDash:
      case S.ScriptEscDashDash:
        if (c === EOF) return false;
        if (c === 0x2d) {
          this.state = this.state === S.ScriptEsc ? S.ScriptEscDash : S.ScriptEscDashDash;
          this.emitText('-');
        } else if (c === 0x3c) this.state = S.ScriptEscLt;
        else if (c === 0x3e && this.state === S.ScriptEscDashDash) {
          this.state = S.Script;
          this.emitText('>');
        } else {
          this.state = S.ScriptEsc;
          this.emitText(c === 0 ? REPLACEMENT : String.fromCharCode(c));
        }
        this.pos++;
        return true;
      case S.ScriptEscLt:
        if (c === 0x2f) {
          this.tempBuf = '';
          this.state = S.ScriptEscEndOpen;
          this.pos++;
        } else if (isAlpha(c)) {
          this.tempBuf = '';
          this.emitText('<');
          this.state = S.ScriptDescStart;
        } else {
          this.emitText('<');
          this.state = S.ScriptEsc;
        }
        return true;
      case S.ScriptDescStart:
      case S.ScriptDescEnd: {
        const toEsc = this.state === S.ScriptDescStart;
        if (isWs(c) || c === 0x2f || c === 0x3e) {
          this.state = this.tempBuf === 'script' ? (toEsc ? S.ScriptDesc : S.ScriptEsc) : toEsc ? S.ScriptEsc : S.ScriptDesc;
          this.emitText(String.fromCharCode(c));
          this.pos++;
        } else if (isAlpha(c)) {
          this.tempBuf += lower(c);
          this.emitText(String.fromCharCode(c));
          this.pos++;
        } else this.state = toEsc ? S.ScriptEsc : S.ScriptDesc;
        return true;
      }
      case S.ScriptDesc:
      case S.ScriptDescDash:
      case S.ScriptDescDashDash:
        if (c === EOF) return false;
        if (c === 0x2d) {
          this.state = this.state === S.ScriptDesc ? S.ScriptDescDash : S.ScriptDescDashDash;
          this.emitText('-');
        } else if (c === 0x3c) {
          this.state = S.ScriptDescLt;
          this.emitText('<');
        } else if (c === 0x3e && this.state === S.ScriptDescDashDash) {
          this.state = S.Script;
          this.emitText('>');
        } else {
          this.state = S.ScriptDesc;
          this.emitText(c === 0 ? REPLACEMENT : String.fromCharCode(c));
        }
        this.pos++;
        return true;
      case S.ScriptDescLt:
        if (c === 0x2f) {
          this.tempBuf = '';
          this.state = S.ScriptDescEnd;
          this.emitText('/');
          this.pos++;
        } else this.state = S.ScriptDesc;
        return true;
      case S.BeforeAttrName:
        if (isWs(c)) this.pos++;
        else if (c === 0x2f || c === 0x3e || c === EOF) this.state = S.AfterAttrName;
        else if (c === 0x3d) {
          this.startAttr();
          this.attrName = '=';
          this.grow();
          this.state = S.AttrName;
          this.pos++;
        } else {
          this.startAttr();
          this.state = S.AttrName;
        }
        return true;
      case S.AttrName:
        if (isWs(c) || c === 0x2f || c === 0x3e || c === EOF) this.state = S.AfterAttrName;
        else if (c === 0x3d) {
          this.state = S.BeforeAttrValue;
          this.pos++;
        } else {
          let e = at;
          let name = '';
          while (e < b.length) {
            const d = b.charCodeAt(e);
            if (isWs(d) || d === 0x2f || d === 0x3e || d === 0x3d) break;
            name += d === 0 ? REPLACEMENT : lower(d);
            e++;
          }
          this.attrName += name;
          this.grow(name.length);
          this.pos = e;
        }
        return true;
      case S.AfterAttrName:
        if (isWs(c)) this.pos++;
        else if (c === 0x2f) {
          this.state = S.SelfClosing;
          this.pos++;
        } else if (c === 0x3d) {
          this.state = S.BeforeAttrValue;
          this.pos++;
        } else if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
          this.emitTag();
        } else if (c === EOF) return false;
        else {
          this.startAttr();
          this.state = S.AttrName;
        }
        return true;
      case S.BeforeAttrValue:
        if (isWs(c)) this.pos++;
        else if (c === 0x22) {
          this.state = S.AttrValueDq;
          this.pos++;
        } else if (c === 0x27) {
          this.state = S.AttrValueSq;
          this.pos++;
        } else if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
          this.emitTag();
        } else this.state = S.AttrValueUq;
        return true;
      case S.AttrValueDq:
      case S.AttrValueSq: {
        const quote = this.state === S.AttrValueDq ? 0x22 : 0x27;
        if (c === quote) {
          this.state = S.AfterAttrValueQ;
          this.pos++;
        } else if (c === 0x26) {
          this.returnState = this.state;
          this.state = S.CharRef;
          this.pos++;
        } else if (c === EOF) return false;
        else {
          let e = at;
          while (e < b.length) {
            const d = b.charCodeAt(e);
            if (d === quote || d === 0x26 || d === 0) break;
            e++;
          }
          if (e === at) {
            this.attrValue += REPLACEMENT;
            e++;
          } else this.attrValue += b.slice(at, e);
          this.grow(e - at);
          this.pos = e;
        }
        return true;
      }
      case S.AttrValueUq:
        if (isWs(c)) {
          this.state = S.BeforeAttrName;
          this.pos++;
        } else if (c === 0x26) {
          this.returnState = S.AttrValueUq;
          this.state = S.CharRef;
          this.pos++;
        } else if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
          this.emitTag();
        } else if (c === EOF) return false;
        else {
          this.attrValue += c === 0 ? REPLACEMENT : String.fromCharCode(c);
          this.grow();
          this.pos++;
        }
        return true;
      case S.AfterAttrValueQ:
        if (isWs(c)) {
          this.state = S.BeforeAttrName;
          this.pos++;
        } else if (c === 0x2f) {
          this.state = S.SelfClosing;
          this.pos++;
        } else if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
          this.emitTag();
        } else if (c === EOF) return false;
        else this.state = S.BeforeAttrName;
        return true;
      case S.SelfClosing:
        if (c === 0x3e) {
          this.selfClosing = true;
          this.state = S.Data;
          this.pos++;
          this.emitTag();
        } else if (c === EOF) return false;
        else this.state = S.BeforeAttrName;
        return true;
      case S.BogusComment:
        if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
          this.emitComment();
        } else if (c === EOF) {
          this.emitComment();
          return false;
        } else {
          let e = at;
          while (e < b.length && b.charCodeAt(e) !== 0x3e) e++;
          const part = b.slice(at, e).replace(/\0/g, REPLACEMENT);
          this.comment += part;
          this.grow(part.length);
          this.pos = e;
        }
        return true;
      case S.MarkupDecl: {
        const rest = b.slice(at, at + 7);
        if (rest.startsWith('--')) {
          this.comment = '';
          this.bogus = false;
          this.state = S.CommentStart;
          this.pos += 2;
          return true;
        }
        if (rest.toUpperCase() === 'DOCTYPE') {
          this.state = S.Doctype;
          this.pos += 7;
          return true;
        }
        if (rest === '[CDATA[') {
          this.pos += 7;
          if (this.sink.foreign()) this.state = S.Cdata;
          else {
            this.comment = '[CDATA[';
            this.bogus = true;
            this.state = S.BogusComment;
          }
          return true;
        }
        // A prefix of one of them could still become it once more text arrives.
        if (!this.final && rest.length < 7 && (rest === '-' || 'DOCTYPE'.startsWith(rest.toUpperCase()) || '[CDATA['.startsWith(rest))) return false;
        this.comment = '';
        this.bogus = true;
        this.state = S.BogusComment;
        return true;
      }
      case S.CommentStart:
        if (c === 0x2d) {
          this.state = S.CommentStartDash;
          this.pos++;
        } else if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
          this.emitComment();
        } else this.state = S.Comment;
        return true;
      case S.CommentStartDash:
        if (c === 0x2d) {
          this.state = S.CommentEnd;
          this.pos++;
        } else if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
          this.emitComment();
        } else if (c === EOF) {
          this.emitComment();
          return false;
        } else {
          this.comment += '-';
          this.state = S.Comment;
        }
        return true;
      case S.Comment:
        if (c === 0x3c) {
          this.comment += '<';
          this.state = S.CommentLt;
          this.pos++;
        } else if (c === 0x2d) {
          this.state = S.CommentEndDash;
          this.pos++;
        } else if (c === EOF) {
          this.emitComment();
          return false;
        } else {
          let e = at;
          while (e < b.length) {
            const d = b.charCodeAt(e);
            if (d === 0x3c || d === 0x2d) break;
            e++;
          }
          const part = b.slice(at, e).replace(/\0/g, REPLACEMENT);
          this.comment += part;
          this.grow(part.length);
          this.pos = e;
        }
        return true;
      case S.CommentLt:
        if (c === 0x21) {
          this.comment += '!';
          this.state = S.CommentLtBang;
          this.pos++;
        } else if (c === 0x3c) {
          this.comment += '<';
          this.pos++;
        } else this.state = S.Comment;
        return true;
      case S.CommentLtBang:
        if (c === 0x2d) {
          this.state = S.CommentLtBangDash;
          this.pos++;
        } else this.state = S.Comment;
        return true;
      case S.CommentLtBangDash:
        if (c === 0x2d) {
          this.state = S.CommentLtBangDashDash;
          this.pos++;
        } else this.state = S.CommentEndDash;
        return true;
      case S.CommentLtBangDashDash:
        this.state = S.CommentEnd;
        return true;
      case S.CommentEndDash:
        if (c === 0x2d) {
          this.state = S.CommentEnd;
          this.pos++;
        } else if (c === EOF) {
          this.emitComment();
          return false;
        } else {
          this.comment += '-';
          this.state = S.Comment;
        }
        return true;
      case S.CommentEnd:
        if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
          this.emitComment();
        } else if (c === 0x21) {
          this.state = S.CommentEndBang;
          this.pos++;
        } else if (c === 0x2d) {
          this.comment += '-';
          this.pos++;
        } else if (c === EOF) {
          this.emitComment();
          return false;
        } else {
          this.comment += '--';
          this.state = S.Comment;
        }
        return true;
      case S.CommentEndBang:
        if (c === 0x2d) {
          this.comment += '--!';
          this.state = S.CommentEndDash;
          this.pos++;
        } else if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
          this.emitComment();
        } else if (c === EOF) {
          this.emitComment();
          return false;
        } else {
          this.comment += '--!';
          this.state = S.Comment;
        }
        return true;
      case S.Doctype:
        this.doc = { forceQuirks: false };
        if (isWs(c)) {
          this.state = S.BeforeDoctypeName;
          this.pos++;
        } else if (c === EOF) {
          this.doc.forceQuirks = true;
          this.emitDoctype();
          return false;
        } else this.state = S.BeforeDoctypeName;
        return true;
      case S.BeforeDoctypeName:
        if (isWs(c)) this.pos++;
        else if (c === 0x3e) {
          this.doc.forceQuirks = true;
          this.state = S.Data;
          this.pos++;
          this.emitDoctype();
        } else if (c === EOF) {
          this.doc.forceQuirks = true;
          this.emitDoctype();
          return false;
        } else {
          this.doc.name = c === 0 ? REPLACEMENT : lower(c);
          this.grow();
          this.state = S.DoctypeName;
          this.pos++;
        }
        return true;
      case S.DoctypeName:
        if (isWs(c)) {
          this.state = S.AfterDoctypeName;
          this.pos++;
        } else if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
          this.emitDoctype();
        } else if (c === EOF) {
          this.doc.forceQuirks = true;
          this.emitDoctype();
          return false;
        } else {
          this.doc.name += c === 0 ? REPLACEMENT : lower(c);
          this.grow();
          this.pos++;
        }
        return true;
      case S.AfterDoctypeName: {
        if (isWs(c)) {
          this.pos++;
          return true;
        }
        if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
          this.emitDoctype();
          return true;
        }
        if (c === EOF) {
          this.doc.forceQuirks = true;
          this.emitDoctype();
          return false;
        }
        const word = b.slice(at, at + 6).toUpperCase();
        if (word === 'PUBLIC' || word === 'SYSTEM') {
          this.state = word === 'PUBLIC' ? S.AfterDoctypePublicKw : S.AfterDoctypeSystemKw;
          this.pos += 6;
          return true;
        }
        if (!this.final && word.length < 6 && ('PUBLIC'.startsWith(word) || 'SYSTEM'.startsWith(word))) return false;
        this.doc.forceQuirks = true;
        this.state = S.BogusDoctype;
        return true;
      }
      case S.AfterDoctypePublicKw:
      case S.BeforeDoctypePublicId:
      case S.AfterDoctypeSystemKw:
      case S.BeforeDoctypeSystemId: {
        const publicId = this.state === S.AfterDoctypePublicKw || this.state === S.BeforeDoctypePublicId;
        if (isWs(c)) {
          if (this.state === S.AfterDoctypePublicKw) this.state = S.BeforeDoctypePublicId;
          else if (this.state === S.AfterDoctypeSystemKw) this.state = S.BeforeDoctypeSystemId;
          this.pos++;
        } else if (c === 0x22 || c === 0x27) {
          if (publicId) this.doc.publicId = '';
          else this.doc.systemId = '';
          this.state = publicId ? (c === 0x22 ? S.DoctypePublicIdDq : S.DoctypePublicIdSq) : c === 0x22 ? S.DoctypeSystemIdDq : S.DoctypeSystemIdSq;
          this.pos++;
        } else if (c === 0x3e) {
          this.doc.forceQuirks = true;
          this.state = S.Data;
          this.pos++;
          this.emitDoctype();
        } else if (c === EOF) {
          this.doc.forceQuirks = true;
          this.emitDoctype();
          return false;
        } else {
          this.doc.forceQuirks = true;
          this.state = S.BogusDoctype;
        }
        return true;
      }
      case S.DoctypePublicIdDq:
      case S.DoctypePublicIdSq:
      case S.DoctypeSystemIdDq:
      case S.DoctypeSystemIdSq: {
        const publicId = this.state === S.DoctypePublicIdDq || this.state === S.DoctypePublicIdSq;
        const quote = this.state === S.DoctypePublicIdDq || this.state === S.DoctypeSystemIdDq ? 0x22 : 0x27;
        if (c === quote) {
          this.state = publicId ? S.AfterDoctypePublicId : S.AfterDoctypeSystemId;
          this.pos++;
        } else if (c === 0x3e) {
          this.doc.forceQuirks = true;
          this.state = S.Data;
          this.pos++;
          this.emitDoctype();
        } else if (c === EOF) {
          this.doc.forceQuirks = true;
          this.emitDoctype();
          return false;
        } else {
          const ch = c === 0 ? REPLACEMENT : String.fromCharCode(c);
          if (publicId) this.doc.publicId += ch;
          else this.doc.systemId += ch;
          this.grow();
          this.pos++;
        }
        return true;
      }
      case S.AfterDoctypePublicId:
      case S.BetweenDoctypeIds:
        if (isWs(c)) {
          this.state = S.BetweenDoctypeIds;
          this.pos++;
        } else if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
          this.emitDoctype();
        } else if (c === 0x22 || c === 0x27) {
          this.doc.systemId = '';
          this.state = c === 0x22 ? S.DoctypeSystemIdDq : S.DoctypeSystemIdSq;
          this.pos++;
        } else if (c === EOF) {
          this.doc.forceQuirks = true;
          this.emitDoctype();
          return false;
        } else {
          this.doc.forceQuirks = true;
          this.state = S.BogusDoctype;
        }
        return true;
      case S.AfterDoctypeSystemId:
        if (isWs(c)) this.pos++;
        else if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
          this.emitDoctype();
        } else if (c === EOF) {
          this.doc.forceQuirks = true;
          this.emitDoctype();
          return false;
        } else this.state = S.BogusDoctype;
        return true;
      case S.BogusDoctype:
        if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
          this.emitDoctype();
        } else if (c === EOF) {
          this.emitDoctype();
          return false;
        } else this.pos++;
        return true;
      case S.Cdata:
        if (c === 0x5d) {
          this.state = S.CdataBracket;
          this.pos++;
        } else if (c === EOF) return false;
        else {
          let e = at;
          while (e < b.length && b.charCodeAt(e) !== 0x5d) e++;
          this.emitText(b.slice(at, e));
          this.pos = e;
        }
        return true;
      case S.CdataBracket:
        if (c === 0x5d) {
          this.state = S.CdataEnd;
          this.pos++;
        } else {
          this.emitText(']');
          this.state = S.Cdata;
        }
        return true;
      case S.CdataEnd:
        if (c === 0x5d) {
          this.emitText(']');
          this.pos++;
        } else if (c === 0x3e) {
          this.state = S.Data;
          this.pos++;
        } else {
          this.emitText(']]');
          this.state = S.Cdata;
        }
        return true;
      case S.CharRef:
        this.tempBuf = '&';
        if (isAlnum(c)) this.state = S.NamedRef;
        else if (c === 0x23) {
          this.tempBuf += '#';
          this.state = S.NumericRef;
          this.pos++;
        } else {
          this.flushRef(this.tempBuf);
          this.state = this.returnState;
        }
        return true;
      case S.NamedRef:
        return this.namedRef(b, at);
      case S.NumericRef:
        this.refCode = 0;
        if (c === 0x78 || c === 0x58) {
          this.tempBuf += String.fromCharCode(c);
          this.state = S.HexRefStart;
          this.pos++;
        } else this.state = S.DecRefStart;
        return true;
      case S.HexRefStart:
      case S.DecRefStart:
        if (this.state === S.HexRefStart ? isHex(c) : isDigit(c)) this.state = this.state === S.HexRefStart ? S.HexRef : S.DecRef;
        else {
          this.flushRef(this.tempBuf);
          this.state = this.returnState;
        }
        return true;
      case S.HexRef:
      case S.DecRef: {
        const hex = this.state === S.HexRef;
        if (hex ? isHex(c) : isDigit(c)) {
          const v = isDigit(c) ? c - 0x30 : (c | 0x20) - 0x57;
          this.refCode = Math.min(0x110000, this.refCode * (hex ? 16 : 10) + v);
          this.pos++;
        } else {
          if (c === 0x3b) this.pos++;
          this.state = S.NumericRefEnd;
        }
        return true;
      }
      case S.NumericRefEnd:
        this.flushRef(numericText(this.refCode));
        this.state = this.returnState;
        return true;
      default:
        throw new Error(`Unknown tokenizer state ${this.state}`);
    }
  }

  /**
   * The named character reference state: the longest name in the table that the text starts with. In an attribute
   * value, a match without its semicolon followed by "=" or a letter or digit stays as written.
   */
  private namedRef(b: string, at: number): boolean {
    let e = at;
    while (e < b.length && e - at < LONGEST_REFERENCE && isAlnum(b.charCodeAt(e))) e++;
    if (e < b.length && b.charCodeAt(e) === 0x3b && e - at < LONGEST_REFERENCE) e++;
    // The name could still grow once more text arrives.
    if (e >= b.length && e - at < LONGEST_REFERENCE && !this.final) return false;
    const candidate = b.slice(at, e);
    let k = candidate.length;
    while (k > 0 && !NAMED_REFERENCES.has(candidate.slice(0, k))) k--;
    if (k === 0) {
      // No reference: the ampersand and the letters and digits after it stay as text, as the ambiguous ampersand
      // state leaves them. Letters and digits that arrive later are text in the return state too.
      let run = at;
      while (run < b.length && isAlnum(b.charCodeAt(run))) run++;
      this.flushRef(`&${b.slice(at, run)}`);
      this.pos = run;
      this.state = this.returnState;
      return true;
    }
    const name = candidate.slice(0, k);
    const next = at + k < b.length ? b.charCodeAt(at + k) : EOF;
    if (this.inAttribute() && !name.endsWith(';') && (next === 0x3d || isAlnum(next))) {
      this.flushRef(`&${name}`);
    } else {
      this.flushRef(NAMED_REFERENCES.get(name) ?? '');
    }
    this.pos = at + k;
    this.state = this.returnState;
    return true;
  }
}
