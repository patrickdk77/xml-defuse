import { StopError } from './errors';
import { SpillSink, type TempDir } from './io';
import { type ByteSink, type ByteSource, XmlCategory as C, XmlDetail as D } from './types';

/** A header field, unfolded, with its name as written. */
export type Header = [string, string];

export interface MhtPart {
  /** 1 for the first part, in document order, nested parts included. */
  index: number;
  headers: Header[];
  /** The media type, lowercased, without parameters. 'text/plain' when the part names none, as MIME says. */
  type: string;
  params: Map<string, string>;
  location?: string;
  contentId?: string;
  /** The file name the headers give, if any. */
  name?: string;
  /** Decoded body. Absent for a multipart part, which holds `children` instead. */
  body?: SpillSink;
  children?: MhtPart[];
  /** The transfer encoding is not one this package decodes. */
  undecodable?: string;
}

export interface MhtFile {
  headers: Header[];
  type: string;
  params: Map<string, string>;
  /** The parts of the top-level multipart, or one part when the file is a single body. */
  parts: MhtPart[];
  /** Bytes outside the parts that are more than white space and the usual notice. */
  hidden: number;
}

/** Reads lines, each with its line end, from a source in chunks. */
async function* lines(source: ByteSource, check: () => void): AsyncGenerator<Buffer> {
  const size = await source.size();
  let carry = Buffer.alloc(0);
  for (let pos = 0; pos < size; pos += 65536) {
    check();
    const chunk = Buffer.from(await source.read(pos, Math.min(65536, size - pos)));
    let data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    for (let nl = data.indexOf(0x0a); nl >= 0; nl = data.indexOf(0x0a)) {
      yield data.subarray(0, nl + 1);
      data = data.subarray(nl + 1);
    }
    carry = Buffer.from(data);
  }
  if (carry.length) yield carry;
}

/** A line without its line end. */
const bare = (line: Buffer) => {
  let n = line.length;
  if (n && line[n - 1] === 0x0a) n--;
  if (n && line[n - 1] === 0x0d) n--;
  return line.subarray(0, n);
};

/** The media type and parameters of a Content-Type value. */
export function parseContentType(value: string | undefined): { type: string; params: Map<string, string> } {
  const params = new Map<string, string>();
  if (!value) return { type: 'text/plain', params };
  const [type, ...rest] = splitParams(value);
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    params.set(p.slice(0, eq).trim().toLowerCase(), v);
  }
  return { type: type.trim().toLowerCase() || 'text/plain', params };
}

/** Splits at semicolons outside quoted strings. */
function splitParams(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"') quoted = !quoted;
    if (c === '\\' && quoted && i + 1 < value.length) {
      cur += c + value[++i];
      continue;
    }
    if (c === ';' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const header = (headers: Header[], name: string) => headers.find(h => h[0].toLowerCase() === name)?.[1];

/**
 * Decodes quoted-printable, one line at a time. `hard` tells whether the line ends in a hard line break, which the
 * caller writes as CRLF only once another line follows, since the break before a boundary belongs to the boundary.
 */
function quotedPrintable(line: Buffer): { data: Buffer; hard: boolean } {
  const b = bare(line);
  const hard = b.length !== line.length;
  let end = b.length;
  // Trailing white space is not part of the line, and "=" at the end joins it to the next.
  while (end > 0 && (b[end - 1] === 0x20 || b[end - 1] === 0x09)) end--;
  let soft = false;
  if (end > 0 && b[end - 1] === 0x3d) {
    soft = true;
    end--;
  }
  const out = Buffer.alloc(end);
  let n = 0;
  const hex = (c: number) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1);
  for (let i = 0; i < end; i++) {
    if (b[i] === 0x3d && i + 2 < end && hex(b[i + 1]) >= 0 && hex(b[i + 2]) >= 0) {
      out[n++] = hex(b[i + 1]) * 16 + hex(b[i + 2]);
      i += 2;
    } else out[n++] = b[i];
  }
  return { data: out.subarray(0, n), hard: hard && !soft };
}

/** Decodes base64 a line at a time, keeping the characters left over from one line for the next. */
class Base64Decoder {
  private carry = '';
  feed(line: Buffer): Buffer {
    const s = this.carry + line.toString('latin1').replace(/[^A-Za-z0-9+/]/g, '');
    const whole = s.length - (s.length % 4);
    this.carry = s.slice(whole);
    return Buffer.from(s.slice(0, whole), 'base64');
  }
  end(): Buffer {
    const s = this.carry;
    this.carry = '';
    return s.length > 1 ? Buffer.from(s, 'base64') : Buffer.alloc(0);
  }
}

interface ParseLimits {
  parts: number;
  /** How deep multipart bodies may nest. */
  depth: number;
  decodedBytes: number;
  memoryThreshold: number;
  temp: TempDir;
  check: () => void;
}

const CRLF = Buffer.from('\r\n');

/**
 * The notices mail programs and Word write before the first part, for readers that do not show MIME. Words are
 * matched across any white space, and the product names at the end of Word's notice as any text.
 */
const NOTICES = [
  /this is a multi-?part message in mime format\.?/gi,
  /this document is a single file web page, also known as a web archive file\. if you are seeing this message, your browser or editor doesn't support web archive files\. please download a browser that supports web archive(, such as [^.]*)?\./gi,
];

/**
 * Reads an MHT file: its headers, and the parts of its multipart body, nested multiparts included. Each part's body
 * is decoded from base64 or quoted-printable into memory, or a temporary file past `memoryThreshold`.
 */
export async function readMht(source: ByteSource, limits: ParseLimits): Promise<MhtFile> {
  const it = lines(source, limits.check);
  let pending: Buffer | undefined;
  const next = async (): Promise<Buffer | undefined> => {
    if (pending) {
      const p = pending;
      pending = undefined;
      return p;
    }
    const r = await it.next();
    return r.done ? undefined : r.value;
  };
  const readHeaders = async (): Promise<Header[]> => {
    const out: Header[] = [];
    for (;;) {
      const line = await next();
      if (!line) return out;
      const text = bare(line).toString('latin1');
      if (text === '') return out;
      if (/^[ \t]/.test(text) && out.length) out[out.length - 1][1] += ` ${text.trim()}`;
      else {
        const colon = text.indexOf(':');
        if (colon > 0) out.push([text.slice(0, colon).trim(), text.slice(colon + 1).trim()]);
      }
    }
  };
  let count = 0;
  let hidden = 0;
  let index = 0;
  const notice: Buffer[] = [];

  /** Reads one part's body up to a boundary line. Returns the boundary line that ended it, or undefined at the end. */
  const body = async (part: MhtPart, boundaries: string[]): Promise<string | undefined> => {
    const cte = (header(part.headers, 'content-transfer-encoding') ?? '7bit').trim().toLowerCase();
    if (cte !== 'base64' && cte !== 'quoted-printable' && cte !== '7bit' && cte !== '8bit' && cte !== 'binary') part.undecodable = cte;
    const sink = new SpillSink(limits.temp, limits.memoryThreshold);
    const b64 = new Base64Decoder();
    let lastEnd: Buffer | undefined;
    let ended: string | undefined;
    const write = async (b: Buffer) => {
      if (!b.length) return;
      if (sink.length + b.length > limits.decodedBytes)
        throw new StopError(C.Limit, D.DecodedSize, 'An MHT part decodes larger than the decoded size limit', { limit: limits.decodedBytes }, `part ${part.index}`);
      await sink.write(b);
    };
    for (;;) {
      const line = await next();
      if (!line) break;
      const text = bare(line).toString('latin1').trimEnd();
      const hit = boundaries.find(bd => text === `--${bd}` || text === `--${bd}--`);
      if (hit !== undefined) {
        ended = text;
        break;
      }
      if (cte === 'base64') await write(b64.feed(line));
      else if (cte === 'quoted-printable') {
        if (lastEnd) await write(lastEnd);
        const decoded = quotedPrintable(line);
        await write(decoded.data);
        lastEnd = decoded.hard ? CRLF : undefined;
      } else {
        // The line end before a boundary belongs to the boundary, so each line's end is written only once another line follows.
        if (lastEnd) await write(lastEnd);
        const content = bare(line);
        await write(content);
        lastEnd = line.subarray(content.length);
      }
    }
    if (cte === 'base64') await write(b64.end());
    await sink.close();
    part.body = sink;
    return ended;
  };

  /** Reads the parts of a multipart body after its preamble. */
  const multipart = async (own: string, outer: string[]): Promise<{ parts: MhtPart[]; ended?: string }> => {
    const boundary = own;
    const boundaries = [boundary, ...outer];
    if (boundaries.length > limits.depth) throw new StopError(C.Limit, D.Depth, `Multipart bodies nest deeper than ${limits.depth}`, { limit: limits.depth });
    const parts: MhtPart[] = [];
    // The preamble.
    let ended: string | undefined;
    for (;;) {
      const line = await next();
      if (!line) return { parts };
      const text = bare(line).toString('latin1').trimEnd();
      const hit = boundaries.find(bd => text === `--${bd}` || text === `--${bd}--`);
      if (hit !== undefined) {
        ended = text;
        break;
      }
      notice.push(line);
    }
    while (ended === `--${boundary}`) {
      count++;
      if (count > limits.parts) throw new StopError(C.Limit, D.Parts, `More than ${limits.parts} parts`, { limit: limits.parts });
      const headers = await readHeaders();
      const ct = parseContentType(header(headers, 'content-type'));
      const part: MhtPart = { index: ++index, headers, type: ct.type, params: ct.params };
      part.location = header(headers, 'content-location');
      const cid = header(headers, 'content-id');
      if (cid) part.contentId = cid.replace(/^\s*<|>\s*$/g, '');
      const disposition = parseContentType(header(headers, 'content-disposition'));
      part.name = disposition.params.get('filename') ?? ct.params.get('name');
      const inner = ct.params.get('boundary');
      if (ct.type.startsWith('multipart/') && inner) {
        const r = await multipart(inner, boundaries);
        part.children = r.parts;
        ended = r.ended;
        // The epilogue of the nested multipart, up to the outer boundary.
        if (ended === `--${inner}--`) ended = await skipTo(boundaries);
      } else ended = await body(part, boundaries);
      parts.push(part);
    }
    return { parts, ended };
  };

  /** Skips lines up to one of the boundaries, counting what is not white space. */
  const skipTo = async (boundaries: string[]): Promise<string | undefined> => {
    for (;;) {
      const line = await next();
      if (!line) return undefined;
      const text = bare(line).toString('latin1').trimEnd();
      if (boundaries.some(bd => text === `--${bd}` || text === `--${bd}--`)) return text;
      notice.push(line);
    }
  };

  const headers = await readHeaders();
  const ct = parseContentType(header(headers, 'content-type'));
  const boundary = ct.params.get('boundary');
  let parts: MhtPart[];
  if (ct.type.startsWith('multipart/') && boundary) {
    const r = await multipart(boundary, []);
    parts = r.parts;
    // The epilogue.
    if (r.ended !== undefined) {
      for (let line = await next(); line; line = await next()) notice.push(line);
    }
  } else {
    // A single body, such as an HTML page saved with MIME headers.
    const part: MhtPart = { index: ++index, headers, type: ct.type, params: ct.params, location: header(headers, 'content-location') };
    await body(part, []);
    parts = [part];
  }
  const outside = Buffer.concat(notice).toString('latin1');
  let shown = outside.replace(/\s+/g, ' ');
  for (const n of NOTICES) shown = shown.replace(n, '');
  hidden = shown.replace(/\s+/g, '').length;
  return { headers, type: ct.type, params: ct.params, parts, hidden };
}

/** Every part in document order, nested ones included, without the multipart parts themselves. */
export function leafParts(parts: MhtPart[]): MhtPart[] {
  return parts.flatMap(p => (p.children ? leafParts(p.children) : [p]));
}

/** The part a multipart/related body opens with: the one its start parameter names, or the first, as RFC 2387 says. */
export function rootPart(file: MhtFile): MhtPart | undefined {
  const leaves = leafParts(file.parts);
  const start = file.params.get('start')?.replace(/^\s*<|>\s*$/g, '');
  return (start && leaves.find(p => p.contentId === start)) || leaves[0];
}

/** Writes a header block, dropping the fields `skip` names. */
function headerBlock(headers: Header[], skip: Set<string>): string {
  return headers
    .filter(h => !skip.has(h[0].toLowerCase()))
    .map(h => `${h[0]}: ${h[1]}\r\n`)
    .join('');
}

const quoteParam = (v: string) => (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(v) ? v : `"${v.replace(/["\\]/g, '\\$&')}"`);

/** A Content-Type value with these parameters. */
export function contentType(type: string, params: Map<string, string>): string {
  return [type, ...[...params].map(([k, v]) => `${k}=${quoteParam(v)}`)].join('; ');
}

/** What the rewrite writes for one leaf part: its bytes and its Content-Type, or nothing when the part goes. */
export type PartOutput = { source: ByteSource; contentType: string } | undefined;

/** Writes a source as base64 in lines of 76 characters. */
async function base64Lines(source: ByteSource, write: (text: string) => Promise<void>): Promise<void> {
  const size = await source.size();
  // 57 bytes make one 76-character line of base64.
  const step = 57 * 1024;
  for (let pos = 0; pos < size; pos += step) {
    const encoded = Buffer.from(await source.read(pos, Math.min(step, size - pos))).toString('base64');
    let lines76 = '';
    for (let i = 0; i < encoded.length; i += 76) lines76 += `${encoded.slice(i, i + 76)}\r\n`;
    await write(lines76);
  }
  await source.close?.();
}

/**
 * Writes an MHT file with the same headers and part structure, each kept part in base64, so no part's content is
 * markup to a reader of the whole file. Boundaries are new and cannot occur in base64 text.
 */
export async function writeMht(file: MhtFile, out: ByteSink, output: (part: MhtPart) => Promise<PartOutput>): Promise<void> {
  const write = (text: string) => out.write(Buffer.from(text, 'latin1'));
  let seq = 0;
  const boundaryFor = () => `----=_xml-defuse_${++seq}_boundary`;
  const skip = new Set(['content-type', 'content-transfer-encoding', 'content-length', 'mime-version']);
  const writeParts = async (list: MhtPart[], boundary: string) => {
    for (const p of list) {
      if (p.children) {
        const inner = boundaryFor();
        const params = new Map(p.params);
        params.set('boundary', inner);
        await write(`--${boundary}\r\n${headerBlock(p.headers, skip)}Content-Type: ${contentType(p.type, params)}\r\n\r\n`);
        await writeParts(p.children, inner);
        await write(`--${inner}--\r\n`);
        continue;
      }
      const o = await output(p);
      if (!o) continue;
      await write(`--${boundary}\r\n${headerBlock(p.headers, skip)}Content-Type: ${o.contentType}\r\nContent-Transfer-Encoding: base64\r\n\r\n`);
      await base64Lines(o.source, write);
    }
  };
  if (file.type.startsWith('multipart/') && file.params.get('boundary')) {
    const boundary = boundaryFor();
    const params = new Map(file.params);
    params.set('boundary', boundary);
    await write(`${headerBlock(file.headers, skip)}MIME-Version: 1.0\r\nContent-Type: ${contentType(file.type, params)}\r\n\r\n`);
    await writeParts(file.parts, boundary);
    await write(`--${boundary}--\r\n`);
    return;
  }
  const p = file.parts[0];
  const o = p && (await output(p));
  await write(`${headerBlock(file.headers, skip)}MIME-Version: 1.0\r\n`);
  if (!o) {
    await write('Content-Type: text/plain\r\n\r\n');
    return;
  }
  await write(`Content-Type: ${o.contentType}\r\nContent-Transfer-Encoding: base64\r\n\r\n`);
  await base64Lines(o.source, write);
}
