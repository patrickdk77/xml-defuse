/** Identifies a file type from its first bytes, as pdf-defuse does. Returns a MIME type or undefined. */
export function sniffType(head: Uint8Array): string | undefined {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  // PDF readers accept the header anywhere in the first 1024 bytes.
  const s = b.subarray(0, 1024).toString('latin1');
  if (s.includes('%PDF-')) return 'application/pdf';
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return 'application/zip';
  if (b[0] === 0x89 && s.startsWith('\x89PNG')) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (s.startsWith('GIF87a') || s.startsWith('GIF89a')) return 'image/gif';
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'application/x-ole-storage';
  if (s.startsWith('MZ')) return 'application/x-msdownload';
  if (s.startsWith('\x7fELF')) return 'application/x-executable';
  const text = s.replace(/^\xef\xbb\xbf/, '').trimStart();
  if (/^<svg[\s>/]/i.test(text) || (/^<\?xml/i.test(text) && /<svg[\s>/]/i.test(s))) return 'image/svg+xml';
  if (/^<\?xml/i.test(text)) return 'application/xml';
  if (/^<!doctype html|^<html[\s>]/i.test(text)) return 'text/html';
  return undefined;
}

const EXT: Record<string, string> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  docx: 'application/zip',
  xlsx: 'application/zip',
  pptx: 'application/zip',
  odt: 'application/zip',
  ods: 'application/zip',
  odp: 'application/zip',
  epub: 'application/zip',
  jar: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  doc: 'application/x-ole-storage',
  xls: 'application/x-ole-storage',
  ppt: 'application/x-ole-storage',
  msg: 'application/x-ole-storage',
  exe: 'application/x-msdownload',
  dll: 'application/x-msdownload',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  tab: 'text/tab-separated-values',
  json: 'application/json',
};

/** Maps MIME types that share a container format, and common aliases of one type, onto one family. */
export function family(mime: string): string {
  const m = mime.toLowerCase().split(';')[0].trim();
  if (m === 'image/jpg' || m === 'image/pjpeg') return 'image/jpeg';
  if (m === 'image/x-png') return 'image/png';
  if (m === 'application/x-pdf') return 'application/pdf';
  if (
    m === 'application/zip' ||
    m === 'application/x-zip-compressed' ||
    m === 'application/x-zip' ||
    m.includes('openxmlformats') ||
    m.includes('opendocument') ||
    m === 'application/epub+zip' ||
    m === 'application/java-archive'
  )
    return 'zip';
  if (m === 'image/svg+xml') return 'svg';
  if (m === 'application/xml' || m === 'text/xml') return 'xml';
  if (m === 'application/msword' || m === 'application/vnd.ms-excel' || m === 'application/vnd.ms-powerpoint' || m === 'application/x-ole-storage' || m === 'application/vnd.ms-outlook') return 'ole';
  return m;
}

/**
 * A file name's extension, lowercased. Windows drops trailing dots and spaces when it saves a file, so the extension
 * of "page.html." is html.
 */
export function extensionOf(name?: string): string | undefined {
  // A loop and lastIndexOf, since /[. ]+$/ backtracks: a name of 40,000 dots took seconds to match.
  const n = name ?? '';
  let end = n.length;
  while (end > 0 && (n[end - 1] === '.' || n[end - 1] === ' ')) end--;
  const dot = n.lastIndexOf('.', end - 1);
  const ext = dot < 0 ? '' : n.slice(dot + 1, end);
  return ext && !/[/\\]/.test(ext) ? ext.toLowerCase() : undefined;
}

export function typeFromName(name?: string): string | undefined {
  const ext = extensionOf(name);
  // Only the table's own entries: "x.constructor" names no type.
  return ext !== undefined && Object.hasOwn(EXT, ext) ? EXT[ext] : undefined;
}

/** Families sniffType has a signature for. Content that claims one of them and matches no signature is not what it claims. */
const SNIFFABLE = new Set(['application/pdf', 'zip', 'image/png', 'image/jpeg', 'image/gif', 'ole', 'application/x-msdownload', 'application/x-executable', 'svg', 'xml', 'text/html']);

/**
 * True when any two of the declared type, the name's extension and the sniffed content contradict each other, or
 * when the declared type or the name claims a type sniffType recognizes and the content matched no signature.
 */
export function typesDisagree(declared: string | undefined, name: string | undefined, sniffed: string | undefined): boolean {
  const claimed = [declared, typeFromName(name)].filter((t): t is string => t !== undefined && t !== '' && family(t) !== 'application/octet-stream').map(family);
  const all = sniffed ? [...claimed, family(sniffed)] : claimed;
  const same = (a: string, b: string) => a === b || (a === 'svg' && b === 'xml') || (a === 'xml' && b === 'svg');
  if (all.some(a => all.some(b => !same(a, b)))) return true;
  return !sniffed && claimed.some(f => SNIFFABLE.has(f));
}

/** The first bytes as text: UTF-16 by its byte order mark or its pattern, and as Latin-1 otherwise, which keeps ASCII as it is. */
function headText(head: Uint8Array): string {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le');
  if (b[0] === 0x3c && b[1] === 0) return b.subarray(0, b.length & ~1).toString('utf16le');
  if (b[0] === 0 && b[1] === 0x3c)
    return Buffer.from(b.subarray(0, b.length & ~1))
      .swap16()
      .toString('utf16le');
  return b.toString('latin1').replace(/^\xef\xbb\xbf/, '');
}

/**
 * Whether the file starts with an XML declaration in EBCDIC, the bytes 4C 6F A7 94 for "<?xm" that the XML
 * specification's encoding detection names. xml-defuse does not decode EBCDIC.
 */
export function isEbcdicXml(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x4c && head[1] === 0x6f && head[2] === 0xa7 && head[3] === 0x94;
}

/**
 * Whether the first bytes name a flat OpenDocument document or a Flat OPC package as the root element: Office documents
 * saved as one XML file, which office-defuse reads. The test is the one office-defuse routes them by.
 */
export function isOfficeXml(head: Uint8Array): boolean {
  const text = headText(head);
  const rest = text.replace(/^\uFEFF/, '').replace(/^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/, '');
  const qname = /^<([^\s/>]+)/.exec(rest)?.[1] ?? '';
  const local = qname.slice(qname.indexOf(':') + 1);
  return (local === 'document' && /urn:oasis:names:tc:opendocument:xmlns:office:1\.\d/i.test(text)) || (local === 'package' && text.includes('http://schemas.microsoft.com/office/2006/xmlPackage'));
}

/** HTML element names that start a page, which the WHATWG sniffing rules and common pages begin with. */
const HTML_ROOTS = new Set([
  'html',
  'head',
  'body',
  'script',
  'iframe',
  'h1',
  'div',
  'font',
  'table',
  'a',
  'style',
  'title',
  'b',
  'br',
  'p',
  'meta',
  'link',
  'center',
  'frameset',
  'form',
  'span',
  'img',
  'hta:application',
  'base',
  'noscript',
  'object',
  'embed',
  'applet',
  'pre',
  'ul',
  'ol',
  'section',
  'main',
  'header',
  'nav',
  'article',
  'template',
]);

/** What the first bytes say a markup file is, and what that decided. */
export interface MarkupSniff {
  kind: 'mht' | 'xml' | 'html';
  /** The file starts with an XML declaration. */
  declared: boolean;
  /** The local name of the first element, lowercased, when the bytes reach it. */
  root?: string;
  /** The first element's start tag as written: its qualified name and the text of its attributes. */
  rootTag?: { name: string; attributes: string };
  /**
   * The file says it is XML: it has an XML declaration, its first element other than html declares a namespace, or its
   * document type names something other than HTML. A first element HTML does not know says less.
   */
  xml?: boolean;
}

/**
 * Decides from the first bytes, about 4 KiB, how a file is read: as MHT when it starts with MIME headers that name a
 * multipart body or one markup body, as XML when it has an XML declaration or its first element is not an HTML one or
 * declares a namespace, and as HTML when it starts with markup otherwise or with the HTML5 document type declaration.
 * Undefined when it starts with none of these.
 */
export function sniffMarkup(head: Uint8Array): MarkupSniff | undefined {
  const text = headText(head);
  const t = text.replace(/^[\s\0]+/, '');
  if (/^[!-9;-~]+:/.test(t)) {
    const headers = t.split(/\r?\n\r?\n/, 1)[0];
    const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
    if (/^content-type:[ \t]*(multipart\/|message\/rfc822)/im.test(unfolded)) return { kind: 'mht', declared: false };
    // A page saved as one MIME body, which a reader of MHT files shows as it shows a multipart one.
    if (/^mime-version:/im.test(unfolded) && /^content-type:[ \t]*(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml)\b/im.test(unfolded))
      return { kind: 'mht', declared: false };
  }
  if (!/^<[!?/A-Za-z]/.test(t)) return undefined;
  const declared = /^<\?xml[\s?]/.test(t);
  // The first start tag after comments, processing instructions and a document type declaration.
  let rest = t;
  let doctype: string | undefined;
  /** The HTML5 document type declaration, which names no DTD. */
  let html5 = false;
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (rest.startsWith('<!--')) {
      const close = rest.indexOf('-->');
      if (close < 0) break;
      rest = rest.slice(close + 3);
    } else if (rest.startsWith('<?')) {
      const close = rest.indexOf('>');
      if (close < 0) break;
      rest = rest.slice(close + 1);
    } else if (/^<!doctype/i.test(rest)) {
      doctype = /^<!doctype\s+([^\s>[]+)/i.exec(rest)?.[1]?.toLowerCase();
      html5 = /^<!doctype\s+html\s*(system\s+(["'])about:legacy-compat\2\s*)?>/i.test(rest);
      const close = rest.search(/[>[]/);
      if (close < 0) break;
      if (rest[close] === '[') {
        const end = rest.indexOf(']>', close);
        if (end < 0) break;
        rest = rest.slice(end + 2);
      } else rest = rest.slice(close + 1);
    } else break;
  }
  const tag = /^<([A-Za-z_][^\s/>]*)([^>]*)/.exec(rest);
  const root = tag?.[1].toLowerCase();
  const rootTag = tag ? { name: tag[1], attributes: tag[2] } : undefined;
  if (declared) return { kind: 'xml', declared, root, rootTag, xml: true };
  // Only HTML has this declaration, so it decides whatever the root element says.
  if (html5) return { kind: 'html', declared, root, rootTag };
  const xmlDoctype = doctype !== undefined && doctype !== 'html';
  if (!root) return { kind: xmlDoctype ? 'xml' : 'html', declared, root, rootTag, xml: xmlDoctype };
  // A namespace declaration on the first element marks an XML vocabulary. Without one, an svg or math element is
  // inert as XML and is read as HTML, the only reading in which it does anything.
  // A page written as XHTML and served as HTML often has one on its html element, which says nothing on its own.
  if (/\sxmlns(:[^\s=]+)?\s*=/.test(tag?.[2] ?? '')) return { kind: 'xml', declared, root, rootTag, xml: root !== 'html' || xmlDoctype };
  if (HTML_ROOTS.has(root) || root === 'svg' || root === 'math') return { kind: xmlDoctype ? 'xml' : 'html', declared, root, rootTag, xml: xmlDoctype };
  return { kind: 'xml', declared, root, rootTag, xml: xmlDoctype };
}
