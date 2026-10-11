import { TextDecoder } from 'node:util';

/** A streaming decoder as TextDecoder offers one. */
export interface Decoder {
  readonly encoding: string;
  decode(bytes?: Uint8Array, options?: { stream?: boolean }): string;
}

/** Labels the WHATWG Encoding Standard maps to the replacement encoding, which decodes any input to one U+FFFD. */
const REPLACEMENT_LABELS = new Set(['csiso2022kr', 'hz-gb-2312', 'iso-2022-cn', 'iso-2022-cn-ext', 'iso-2022-kr', 'replacement']);

/** The x-user-defined decoder: ASCII as it is, and each other byte to U+F780 plus its value less 0x80. */
class UserDefinedDecoder implements Decoder {
  readonly encoding = 'x-user-defined';
  decode(bytes?: Uint8Array): string {
    let out = '';
    for (const b of bytes ?? []) out += String.fromCharCode(b < 0x80 ? b : 0xf780 + b - 0x80);
    return out;
  }
}

class ReplacementDecoder implements Decoder {
  readonly encoding = 'replacement';
  private done = false;
  decode(bytes?: Uint8Array): string {
    if (this.done || !bytes?.length) return '';
    this.done = true;
    return '\uFFFD';
  }
}

/** Node's own x-user-defined decoder where it has one, chosen once. Node 18 lacks it. */
const nativeUserDefined = (() => {
  try {
    return new TextDecoder('x-user-defined').encoding === 'x-user-defined';
  } catch {
    return false;
  }
})();

/** The encoding a label names, as the Encoding Standard's "get an encoding" gives it, or undefined for none. */
export function encodingFor(label: string): string | undefined {
  const l = label.trim().toLowerCase();
  if (REPLACEMENT_LABELS.has(l)) return 'replacement';
  if (l === 'x-user-defined') return 'x-user-defined';
  try {
    return new TextDecoder(l).encoding;
  } catch {
    return undefined;
  }
}

/** A decoder that turns bytes that are not valid into U+FFFD, as browsers decode HTML. */
export function decoderFor(encoding: string): Decoder {
  if (encoding === 'replacement') return new ReplacementDecoder();
  if (encoding === 'x-user-defined' && !nativeUserDefined) return new UserDefinedDecoder();
  return new TextDecoder(encoding, { ignoreBOM: true });
}

/** The encoding a byte order mark names, and its length. */
export function bomOf(b: Uint8Array): { encoding: string; length: number } | undefined {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { encoding: 'utf-8', length: 3 };
  if (b[0] === 0xfe && b[1] === 0xff) return { encoding: 'utf-16be', length: 2 };
  if (b[0] === 0xff && b[1] === 0xfe) return { encoding: 'utf-16le', length: 2 };
  return undefined;
}

const isSpace = (c: number) => c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
const isLetter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const lowerByte = (c: number) => (c >= 0x41 && c <= 0x5a ? c + 0x20 : c);

/** The charset a meta element's content attribute names, as "extracting a character encoding from a meta element" reads it. */
export function charsetFromContent(content: string): string | undefined {
  let i = 0;
  const s = content;
  for (;;) {
    const at = s.toLowerCase().indexOf('charset', i);
    if (at < 0) return undefined;
    i = at + 7;
    while (i < s.length && isSpace(s.charCodeAt(i))) i++;
    if (s[i] !== '=') continue;
    i++;
    while (i < s.length && isSpace(s.charCodeAt(i))) i++;
    const q = s[i];
    if (q === '"' || q === "'") {
      const close = s.indexOf(q, i + 1);
      return close < 0 ? undefined : s.slice(i + 1, close);
    }
    let e = i;
    while (e < s.length && !isSpace(s.charCodeAt(e)) && s[e] !== ';') e++;
    return e > i ? s.slice(i, e) : undefined;
  }
}

/**
 * What the WHATWG prescan finds in the first 1024 bytes: the encoding a meta element declares, and the label as
 * written. UTF-16 becomes UTF-8 and x-user-defined becomes windows-1252, as the standard says.
 */
export function prescan(bytes: Uint8Array): { encoding: string; label: string } | undefined {
  const b = bytes.subarray(0, 1024);
  const n = b.length;
  let p = 0;
  const startsWith = (s: string, at: number) => {
    for (let k = 0; k < s.length; k++) if (at + k >= n || lowerByte(b[at + k]) !== s.charCodeAt(k)) return false;
    return true;
  };
  /** Reads one attribute from p, or undefined at ">" or the end. */
  const attribute = (): { name: string; value: string } | undefined => {
    while (p < n && (isSpace(b[p]) || b[p] === 0x2f)) p++;
    if (p >= n || b[p] === 0x3e) return undefined;
    let name = '';
    let value = '';
    for (;;) {
      if (p >= n) return { name, value };
      const c = b[p];
      if (c === 0x3d && name !== '') {
        p++;
        break;
      }
      if (isSpace(c)) {
        while (p < n && isSpace(b[p])) p++;
        if (b[p] !== 0x3d) return { name, value };
        p++;
        break;
      }
      if (c === 0x2f || c === 0x3e) return { name, value };
      name += String.fromCharCode(lowerByte(c));
      p++;
    }
    while (p < n && isSpace(b[p])) p++;
    if (p >= n) return { name, value };
    const q = b[p];
    if (q === 0x22 || q === 0x27) {
      p++;
      while (p < n && b[p] !== q) value += String.fromCharCode(lowerByte(b[p++]));
      p++;
      return { name, value };
    }
    while (p < n && !isSpace(b[p]) && b[p] !== 0x3e) value += String.fromCharCode(lowerByte(b[p++]));
    return { name, value };
  };
  while (p < n) {
    if (startsWith('<!--', p)) {
      let e = p + 2;
      while (e + 2 < n && !(b[e] === 0x2d && b[e + 1] === 0x2d && b[e + 2] === 0x3e)) e++;
      p = e + 3;
    } else if (startsWith('<meta', p) && p + 5 < n && (isSpace(b[p + 5]) || b[p + 5] === 0x2f)) {
      p += 5;
      const seen = new Set<string>();
      let gotPragma = false;
      let needPragma: boolean | undefined;
      let label: string | undefined;
      for (let a = attribute(); a; a = attribute()) {
        if (seen.has(a.name)) continue;
        seen.add(a.name);
        if (a.name === 'http-equiv' && a.value === 'content-type') gotPragma = true;
        else if (a.name === 'content' && label === undefined) {
          const found = charsetFromContent(a.value);
          if (found !== undefined) {
            label = found;
            needPragma = true;
          }
        } else if (a.name === 'charset') {
          label = a.value;
          needPragma = false;
        }
      }
      if (needPragma === undefined || label === undefined || (needPragma && !gotPragma)) continue;
      const enc = encodingFor(label);
      if (enc === undefined) continue;
      if (enc === 'utf-16be' || enc === 'utf-16le') return { encoding: 'utf-8', label };
      if (enc === 'x-user-defined') return { encoding: 'windows-1252', label };
      return { encoding: enc, label };
    } else if (b[p] === 0x3c && (isLetter(b[p + 1] ?? 0) || (b[p + 1] === 0x2f && isLetter(b[p + 2] ?? 0)))) {
      while (p < n && !isSpace(b[p]) && b[p] !== 0x3e) p++;
      while (attribute());
    } else if (b[p] === 0x3c && (b[p + 1] === 0x21 || b[p + 1] === 0x2f || b[p + 1] === 0x3f)) {
      while (p < n && b[p] !== 0x3e) p++;
      p++;
    } else p++;
  }
  return undefined;
}

/** A label that names UTF-7, which no browser decodes now but older Internet Explorer did. */
export const isUtf7Label = (label: string) => /^\s*(utf-?7|unicode-1-1-utf-7|csunicode11utf7|x-unicode20utf7)\s*$/i.test(label);
