import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bufferSink, bufferSource, type DefuseFinding, disarmXml, inspectXml, type XmlDisarmResult, type XmlInspection, type XmlOptions } from '../../src';
import { disarmAtDepth, inspectAtDepth } from '../../src/engine';

/** The package root. This file runs from build-test/test/helpers. */
export const root = path.join(__dirname, '..', '..', '..');
export const fixtures = path.join(root, 'test', 'fixtures');
export const fixture = (...parts: string[]) => fs.readFileSync(path.join(fixtures, ...parts));

const cli = path.join(root, 'dist', 'cli.js');
/** Runs the built command-line tool. */
export const runCli = (args: string[], opts: { input?: Buffer; env?: NodeJS.ProcessEnv; cwd?: string } = {}) =>
  spawnSync(process.execPath, [cli, ...args], { input: opts.input, env: { ...process.env, ...opts.env }, cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 });

export const kind = (f: DefuseFinding) => `${f.category}/${f.detail}`;
export const kinds = (i: { findings: DefuseFinding[] }) => i.findings.map(kind);
/** The kinds of finding, each once, in the order they first appear. */
export const kindSet = (i: { findings: DefuseFinding[] }) => [...new Set(kinds(i))];
/** The findings of one kind, such as 'SCRIPT/ELEMENT'. */
export const of = (i: { findings: DefuseFinding[] }, k: string) => i.findings.filter(f => kind(f) === k);
export const has = (i: { findings: DefuseFinding[] }, k: string) => of(i, k).length > 0;
/** The kinds of finding that change the file: everything but info, each once and sorted. */
export const acted = (i: { findings: DefuseFinding[] }) => [...new Set(i.findings.filter(f => f.action !== 'info').map(kind))].sort();

/** Returns `value`, or fails the test when it is null or undefined. `what` names the value in the failure. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value;
}

const bytesOf = (input: string | Uint8Array) => (typeof input === 'string' ? Buffer.from(input, 'utf8') : input);

export const inspect = (input: string | Uint8Array, options: XmlOptions = {}): Promise<XmlInspection> => inspectXml(bytesOf(input), options);

/** Defuses `input` and returns the result with the output as text, '' when rejected. */
export async function disarm(input: string | Uint8Array, options: XmlOptions = {}): Promise<XmlDisarmResult & { text: string; bytes?: Uint8Array }> {
  const r = await disarmXml(bytesOf(input), options);
  return { ...r, text: r.bytes ? Buffer.from(r.bytes).toString('utf8') : '' };
}

/** Inspects `input` as a file with this name, as the command-line tool and the plugin do. */
export const inspectNamed = (input: string | Uint8Array, name: string, options: XmlOptions = {}) => inspectAtDepth(bufferSource(bytesOf(input)), options, 0, undefined, name);

/** Defuses `input` as a file with this name, as the command-line tool and the plugin do. */
export async function disarmNamed(input: string | Uint8Array, name: string, options: XmlOptions = {}): Promise<XmlDisarmResult & { bytes?: Uint8Array }> {
  const sink = bufferSink();
  const r = await disarmAtDepth(bufferSource(bytesOf(input)), sink, options, 0, undefined, name);
  return r.status === 'rejected' ? r : { ...r, bytes: sink.result() };
}

/** The output of a defused file as text, without the byte order mark an HTML output starts with. */
export const body = (r: { text: string }) => r.text.replace(/^\uFEFF/, '');

/** An HTML page around `content`. */
export const page = (content: string) => `<!DOCTYPE html>\n<html><head><title>t</title></head><body>\n${content}\n</body></html>\n`;

/** An SVG drawing around `content`. */
export const svg = (content: string, rootAttributes = '') =>
  `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"${rootAttributes} width="10" height="10">${content}</svg>\n`;

/** An XSLT stylesheet around `content`, with extra namespace declarations. */
export const xsl = (content: string, namespaces = '', version = '1.0') =>
  `<?xml version="1.0"?>\n<xsl:stylesheet version="${version}" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"${namespaces}>${content}</xsl:stylesheet>\n`;

/** A one-pixel PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** An MHT file of these parts, each a header block and a body. */
export const mht = (parts: string[], headers = 'Content-Type: multipart/related; boundary="b1"; type="text/html"') =>
  `MIME-Version: 1.0\r\n${headers}\r\n\r\n${parts.map(p => `--b1\r\n${p}\r\n`).join('')}--b1--\r\n`;
