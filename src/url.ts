import { XmlDetail as D } from './types';

/**
 * A URL as a browser reads it: leading and trailing spaces and controls go, and so do tab and newline anywhere. The
 * other controls go too, since older readers skipped them inside a scheme.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removes the control characters a browser drops from a URL.
export const cleanUrl = (raw: string) => raw.replace(/[\x00-\x1f\x7f]/g, '').trim();

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/** The scheme of a URL, lowercased, or undefined for a relative one. */
export function schemeOf(raw: string): string | undefined {
  return SCHEME.exec(cleanUrl(raw))?.[1].toLowerCase();
}

/** Schemes that run script when a link or a resource loads them. */
export const isScriptScheme = (scheme: string | undefined) => scheme === 'javascript' || scheme === 'vbscript' || scheme === 'livescript' || scheme === 'mocha';

const networkPrefix = (s: string) => s.startsWith('\\\\') || s.startsWith('//') || s.startsWith('\\/') || s.startsWith('/\\');

/** Where a URL that loads on its own, such as an image source, would load from. */
export type ResourceTarget =
  /** Nothing loads: empty, a fragment of this document, about:blank. */
  | 'none'
  /** A cid: or mid: URL, which names a part of the message or MHT file around it. */
  | 'part'
  | 'data'
  | 'script'
  /** file: without a host, or a drive letter. */
  | 'local'
  /** A UNC path, or file: and SMB-like schemes with a host. */
  | 'network'
  /** http, https, a relative URL, or one that starts with // and keeps the page's scheme. */
  | 'remote'
  | 'other';

export function resourceTarget(raw: string): ResourceTarget {
  const u = cleanUrl(raw);
  if (u === '' || u.startsWith('#')) return 'none';
  if (u.startsWith('\\\\') || u.startsWith('\\/') || u.startsWith('/\\')) return 'network';
  const m = SCHEME.exec(u);
  if (!m) return 'remote';
  const scheme = m[1].toLowerCase();
  if (scheme.length === 1) return 'local';
  if (isScriptScheme(scheme)) return 'script';
  if (scheme === 'data') return 'data';
  if (scheme === 'http' || scheme === 'https') return 'remote';
  if (scheme === 'cid' || scheme === 'mid') return 'part';
  if (scheme === 'about') return u.toLowerCase() === 'about:blank' ? 'none' : 'other';
  if (scheme === 'smb' || scheme === 'cifs' || scheme === 'afp' || scheme === 'nfs' || scheme === 'webdav') return 'network';
  if (scheme === 'file') {
    let host = '';
    try {
      host = new URL(u).hostname;
    } catch {
      // A file: URL the parser refuses is read as a local path.
    }
    return host && host.toLowerCase() !== 'localhost' ? 'network' : 'local';
  }
  return 'other';
}

/** True for a segment of nothing but dots and spaces, the empty one included. */
function onlyDotsAndSpaces(seg: string): boolean {
  for (const c of seg) if (c !== '.' && c !== ' ') return false;
  return true;
}

/**
 * True for a relative URL: one with no scheme that does not start with // or a backslash, so it resolves against the
 * page's own address. A fragment alone names a place in this document and is not one.
 */
export function isRelativeUrl(raw: string): boolean {
  const u = cleanUrl(raw);
  return u !== '' && !u.startsWith('#') && !networkPrefix(u) && !u.startsWith('\\') && !SCHEME.test(u);
}

const isXmlSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const PSEUDO_NAME = /[A-Za-z_:][-A-Za-z0-9._:]*/y;
const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' };

/**
 * The pseudo-attributes of an xml-stylesheet or xml-model instruction, read as the W3C recommendation "Associating
 * Style Sheets with XML documents" defines them: names and quoted values separated by white space, with character
 * references and the five predefined entity references in values written out. Undefined when the data does not read
 * that way, a name repeats, or a value holds `<` or another reference, so a caller can treat the instruction as one
 * it cannot judge.
 */
export function pseudoAttributes(data: string): Map<string, string> | undefined {
  const out = new Map<string, string>();
  let i = 0;
  const n = data.length;
  for (;;) {
    const before = i;
    while (i < n && isXmlSpace(data[i])) i++;
    if (i >= n) return out;
    // Two pseudo-attributes need white space between them.
    if (out.size > 0 && i === before) return undefined;
    PSEUDO_NAME.lastIndex = i;
    const name = PSEUDO_NAME.exec(data)?.[0];
    if (name === undefined) return undefined;
    i += name.length;
    while (i < n && isXmlSpace(data[i])) i++;
    if (data[i] !== '=') return undefined;
    i++;
    while (i < n && isXmlSpace(data[i])) i++;
    const quote = data[i];
    if (quote !== '"' && quote !== "'") return undefined;
    const end = data.indexOf(quote, i + 1);
    if (end < 0) return undefined;
    const raw = data.slice(i + 1, end);
    if (raw.includes('<') || out.has(name)) return undefined;
    let value = '';
    for (let k = 0; k < raw.length; k++) {
      if (raw[k] !== '&') {
        value += raw[k];
        continue;
      }
      const semi = raw.indexOf(';', k);
      if (semi < 0) return undefined;
      const ref = raw.slice(k + 1, semi);
      let code: number | undefined;
      if (/^#x[0-9A-Fa-f]{1,6}$/.test(ref)) code = Number.parseInt(ref.slice(2), 16);
      else if (/^#[0-9]{1,7}$/.test(ref)) code = Number.parseInt(ref.slice(1), 10);
      if (code !== undefined) {
        if (code > 0x10ffff) return undefined;
        value += String.fromCodePoint(code);
      } else if (PREDEFINED[ref] !== undefined) value += PREDEFINED[ref];
      else return undefined;
      k = semi;
    }
    out.set(name, value);
    i = end + 1;
  }
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
const isDigit = (c: string) => c >= '0' && c <= '9';

/**
 * Every address a meta refresh's content can send the browser to, or undefined when its time does not parse and a
 * browser ignores it. The first is what the HTML standard's shared declarative refresh steps take: the text after
 * "url=" when that prefix is there, cut at a closing quote, and otherwise the text after the separator. The others are
 * what readers before the standard took: the text after the separator as it stands, and the text after each "url=".
 * An empty address is the page itself.
 */
export function refreshTargets(content: string): string[] | undefined {
  const n = content.length;
  let p = 0;
  while (p < n && isSpace(content[p])) p++;
  const timeStart = p;
  while (p < n && isDigit(content[p])) p++;
  if (p === timeStart && content[p] !== '.') return undefined;
  while (p < n && (isDigit(content[p]) || content[p] === '.')) p++;
  if (p >= n) return [''];
  if (content[p] !== ';' && content[p] !== ',' && !isSpace(content[p])) return undefined;
  while (p < n && isSpace(content[p])) p++;
  if (p < n && (content[p] === ';' || content[p] === ',')) p++;
  while (p < n && isSpace(content[p])) p++;
  if (p >= n) return [''];
  const rest = content.slice(p);
  const unquote = (at: number) => {
    const q = content[at] === "'" || content[at] === '"' ? content[at] : '';
    const s = content.slice(q ? at + 1 : at);
    const end = q ? s.indexOf(q) : -1;
    return end < 0 ? s : s.slice(0, end);
  };
  let target = rest;
  const lower = content.slice(p, p + 3).toLowerCase();
  if (lower[0] !== 'u') target = unquote(p);
  else if (lower === 'url') {
    let q = p + 3;
    while (q < n && isSpace(content[q])) q++;
    if (content[q] === '=') {
      q++;
      while (q < n && isSpace(content[q])) q++;
      target = unquote(q);
    }
  }
  const out = new Set([target, rest]);
  const folded = content.toLowerCase();
  for (let at = folded.indexOf('url', p); at >= 0; at = folded.indexOf('url', at + 3)) {
    let q = at + 3;
    while (q < n && isSpace(content[q])) q++;
    if (content[q] !== '=') continue;
    q++;
    while (q < n && isSpace(content[q])) q++;
    const v = unquote(q);
    const semi = v.indexOf(';');
    out.add(semi < 0 ? v : v.slice(0, semi));
  }
  return [...out];
}

/**
 * Why a relative URL's path is written to read as another path, or undefined for an ordinary one. Climbing with ..
 * from the start, as ../images/a.png does, is ordinary. Odd is a control character a browser drops, a backslash a
 * browser reads as a slash, an encoded dot, slash, backslash or NUL, a segment of only dots and spaces, which Windows
 * reads as .. or as nothing, and a path that names a folder and then climbs above where it started.
 */
export function pathTrick(raw: string): string | undefined {
  const u = raw.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: finds the control characters a browser drops from a URL.
  if (/[\x00-\x1f\x7f]/.test(u)) return 'a control character, which browsers drop before they read the address';
  const end = u.search(/[?#]/);
  const path = end < 0 ? u : u.slice(0, end);
  if (path.includes('\\')) return 'a backslash, which browsers read as a slash';
  if (/%(2e|2f|5c|00)/i.test(path)) return 'an encoded dot, slash, backslash or NUL in the path';
  let depth = 0;
  let named = false;
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (depth > 0) depth--;
      else if (named) return 'a path that names a folder and then climbs above where it started';
      continue;
    }
    if (onlyDotsAndSpaces(seg)) return 'a segment of only dots and spaces, which Windows reads as .. or as nothing';
    depth++;
    named = true;
  }
  return undefined;
}

interface LinkVerdict {
  /** LINK detail, or URL for a link that runs script. */
  detail: D;
  /** Why a relative link is a PATH_TRICK. */
  reason?: string;
  host?: string;
  /** For a safe target, the hosts a label is compared with, in order. */
  sites?: string[];
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A host as LabelSites compares it. */
const siteName = (h: string) =>
  h
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');

/**
 * The hosts a label names, as a lookup: has() answers whether a host is one of them or a subdomain of one, or one of
 * them is a subdomain of the host, at a cost that depends on the host and not on how many the label names. Taken
 * from pdf-defuse.
 */
export class LabelSites {
  private readonly hosts = new Set<string>();
  /** Every domain some label host is a subdomain of. */
  private readonly parents = new Set<string>();
  constructor(names: string[]) {
    for (const n of names) {
      const x = siteName(n);
      this.hosts.add(x);
      for (let i = x.indexOf('.'); i >= 0; i = x.indexOf('.', i + 1)) this.parents.add(x.slice(i + 1));
    }
  }
  get size(): number {
    return this.hosts.size;
  }
  has(host: string): boolean {
    const y = siteName(host);
    if (this.hosts.has(y) || this.parents.has(y)) return true;
    for (let i = y.indexOf('.'); i >= 0; i = y.indexOf('.', i + 1)) if (this.hosts.has(y.slice(i + 1))) return true;
    return false;
  }
}

/** Classifies a link target as pdf-defuse does. `base` is the document's base address, if one is kept. */
export function checkLink(rawUri: string, base?: string): LinkVerdict {
  let uri = cleanUrl(rawUri);
  if (networkPrefix(uri)) return { detail: D.NetworkPath };
  let m = SCHEME.exec(uri);
  if (!m) {
    const trick = pathTrick(rawUri);
    if (trick) return { detail: D.PathTrick, reason: trick };
    if (base) {
      const b = checkLink(base);
      if (b.detail !== D.Safe) return { detail: D.Relative };
      try {
        uri = new URL(uri, cleanUrl(base)).toString();
        m = SCHEME.exec(uri);
      } catch {
        return { detail: D.Relative };
      }
    }
    if (!m) return { detail: D.Relative };
  }
  const scheme = m[1].toLowerCase();
  if (scheme.length === 1) return { detail: D.FileUrl };
  if (isScriptScheme(scheme)) return { detail: D.Url };
  if (scheme === 'data') return { detail: D.DataUrl };
  if (scheme === 'smb' || scheme === 'cifs' || scheme === 'afp' || scheme === 'nfs') return { detail: D.NetworkPath };
  if (scheme === 'file') {
    let host = '';
    try {
      host = new URL(uri).hostname;
    } catch {
      // A file: URL the parser refuses is read as a local path.
    }
    return { detail: host && host.toLowerCase() !== 'localhost' ? D.NetworkPath : D.FileUrl };
  }
  if (scheme === 'mailto') {
    let addr = uri.slice(7).split('?')[0];
    try {
      addr = decodeURIComponent(addr);
    } catch {
      // The address stays as written.
    }
    const domain = addr.includes('@') ? addr.slice(addr.lastIndexOf('@') + 1).toLowerCase() : '';
    return hostVerdict(domain, domain) ?? { detail: D.Safe, host: domain, sites: [domain] };
  }
  if (scheme !== 'http' && scheme !== 'https') return { detail: D.OtherScheme };
  // The authority as written, before the URL parser normalizes it.
  const rawAuth = /^[a-zA-Z]+:[\\/]*([^/\\?#]*)/.exec(uri)?.[1] ?? '';
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { detail: D.OtherScheme };
  }
  if (parsed.username || parsed.password || rawAuth.includes('@')) return { detail: D.Credentials };
  // The parser lowercases, punycodes and turns every IPv4 shorthand into dotted form, as browsers do.
  const host = parsed.hostname.replace(/\.$/, '');
  return hostVerdict(host, rawAuth) ?? { detail: D.Safe, host, sites: [host] };
}

function hostVerdict(host: string, raw: string): LinkVerdict | undefined {
  if (!host) return { detail: D.OtherScheme };
  if (raw.includes('%')) return { detail: D.EncodedHost };
  if (host.startsWith('[') || IPV4.test(host)) return { detail: D.IpHost };
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return { detail: D.IpHost };
  if (/\P{ASCII}/u.test(host) || host.split('.').some(label => label.startsWith('xn--'))) return { detail: D.LookalikeHost };
  return undefined;
}

/** Host names written in free text, such as a link's text. Taken from pdf-defuse. */
export function hostsIn(text: string): string[] {
  const out: string[] = [];
  // The first lookahead caps a candidate at a DNS name's length, so a long run of host characters costs linear time.
  const re = /\b(?:https?:\/\/)?(?=[a-z0-9.-]{1,254}(?![a-z0-9.-]))((?:[a-z0-9-]+\.)+[a-z]{2,})(?=\.*(?:[^a-z0-9.@_-]|$))/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1].toLowerCase());
  return out;
}

/** The bytes a URL's text stands for: its UTF-8 encoding, with each %XX read as one byte. */
function percentDecoded(s: string): Buffer {
  const utf8 = Buffer.from(s, 'utf8');
  const out = Buffer.alloc(utf8.length);
  let n = 0;
  const hex = (c: number) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1);
  for (let i = 0; i < utf8.length; i++) {
    const c = utf8[i];
    if (c === 0x25 && i + 2 < utf8.length && hex(utf8[i + 1]) >= 0 && hex(utf8[i + 2]) >= 0) {
      out[n++] = hex(utf8[i + 1]) * 16 + hex(utf8[i + 2]);
      i += 2;
    } else out[n++] = c;
  }
  return out.subarray(0, n);
}

/** The media type and bytes of a data: URL, as the fetch standard reads one, or undefined when it is not one. */
export function decodeDataUrl(raw: string): { type: string; bytes: Buffer } | undefined {
  const u = cleanUrl(raw);
  const m = /^data:([^,]*),/i.exec(u);
  if (!m) return undefined;
  const params = m[1].split(';').map(p => p.trim());
  const base64 = params.length > 1 && params[params.length - 1].toLowerCase() === 'base64';
  const type = (params[0] || 'text/plain').toLowerCase();
  const bytes = percentDecoded(u.slice(m[0].length));
  if (!base64) return { type, bytes };
  return { type, bytes: Buffer.from(bytes.toString('latin1').replace(/[\t\n\f\r ]+/g, ''), 'base64') };
}
