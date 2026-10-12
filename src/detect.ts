import { bufferSource } from './io';
import { NS } from './markup';
import { isEbcdicXml, isOfficeXml, type MarkupSniff, sniffMarkup } from './sniff';
import type { ByteSource, DetectOptions, FormatDetection, XmlFormat } from './types';

/** The MIME type of each format, as the inspection reports it. */
export const MIME_TYPES: Record<XmlFormat, string> = {
  html: 'text/html',
  xhtml: 'application/xhtml+xml',
  svg: 'image/svg+xml',
  xslt: 'application/xslt+xml',
  xml: 'application/xml',
  mht: 'multipart/related',
  '': '',
};

const EXTENSIONS: Record<XmlFormat, string> = { html: 'html', xhtml: 'xhtml', svg: 'svg', xslt: 'xsl', xml: 'xml', mht: 'mht', '': '' };

/** Bytes the inspection reads to decide between XML and HTML, and as much as detection reads. */
const HEAD = 65536;
/** Bytes the inspection and the plugin look at for an Office document saved as XML. */
const OFFICE_HEAD = 4096;

/** The format the root element of an XML document names: SVG, XSLT, XHTML or plain XML. */
export function formatOfRoot(root: { ns: string; local: string; xsltVersion: boolean } | undefined): XmlFormat {
  if (!root) return 'xml';
  if (root.ns === NS.svg && root.local === 'svg') return 'svg';
  if ((root.ns === NS.xslt && (root.local === 'stylesheet' || root.local === 'transform')) || root.xsltVersion) return 'xslt';
  if (root.ns === NS.html) return 'xhtml';
  return 'xml';
}

/** The root element as its start tag declares it: its namespace from the xmlns attributes on the tag itself. */
function rootOf(tag: MarkupSniff['rootTag']): { ns: string; local: string; xsltVersion: boolean } | undefined {
  if (!tag) return undefined;
  const prefixes = new Map<string, string>();
  for (const m of tag.attributes.matchAll(/\sxmlns(?::([^\s=]+))?\s*=\s*(["'])(.*?)\2/g)) prefixes.set(m[1] ?? '', m[3]);
  const colon = tag.name.indexOf(':');
  const prefix = colon < 0 ? '' : tag.name.slice(0, colon);
  const local = colon < 0 ? tag.name : tag.name.slice(colon + 1);
  let xsltVersion = false;
  for (const m of tag.attributes.matchAll(/\s([^\s=:]+):version\s*=/g)) if (prefixes.get(m[1]) === NS.xslt) xsltVersion = true;
  return { ns: prefixes.get(prefix) ?? '', local, xsltVersion };
}

/**
 * Whether xml-defuse reads `source`, and as which format. It is the test the inspection picks its reader by: markup
 * or MIME headers at the start, and for XML the root element's start tag. An Office document saved as XML is
 * office-defuse's, and text with no markup at the start is not markup, so neither is claimed. XML in EBCDIC is claimed
 * as XML, and the inspection refuses it, since xml-defuse does not decode EBCDIC. The full read can
 * still find XML that does not parse and read it as HTML. The name and declared type play no part. The source stays
 * open.
 */
export async function detectXmlSource(source: ByteSource, _options: DetectOptions = {}): Promise<FormatDetection | undefined> {
  const size = await source.size();
  const head = await source.read(0, Math.min(size, HEAD));
  // XML in EBCDIC is xml-defuse's to refuse: an XML reader that decodes EBCDIC reads it as XML.
  if (isEbcdicXml(head)) return { mimeType: MIME_TYPES.xml, extension: EXTENSIONS.xml, offset: 0 };
  const sniff = sniffMarkup(head);
  if (!sniff) return undefined;
  if (sniff.kind === 'xml' && isOfficeXml(head.subarray(0, OFFICE_HEAD))) return undefined;
  const format: XmlFormat = sniff.kind === 'mht' ? 'mht' : sniff.kind === 'html' ? 'html' : formatOfRoot(rootOf(sniff.rootTag));
  return { mimeType: MIME_TYPES[format], extension: EXTENSIONS[format], offset: 0 };
}

/** `detectXmlSource` over bytes in memory. */
export function detectXml(bytes: Uint8Array, options: DetectOptions = {}): Promise<FormatDetection | undefined> {
  return detectXmlSource(bufferSource(bytes), options);
}
