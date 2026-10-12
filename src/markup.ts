/** Namespaces the rules know. */
export const NS = {
  html: 'http://www.w3.org/1999/xhtml',
  svg: 'http://www.w3.org/2000/svg',
  mathml: 'http://www.w3.org/1998/Math/MathML',
  xlink: 'http://www.w3.org/1999/xlink',
  xml: 'http://www.w3.org/XML/1998/namespace',
  xmlns: 'http://www.w3.org/2000/xmlns/',
  xslt: 'http://www.w3.org/1999/XSL/Transform',
  xinclude: 'http://www.w3.org/2001/XInclude',
  xinclude2003: 'http://www.w3.org/2003/XInclude',
  msxsl: 'urn:schemas-microsoft-com:xslt',
  xmlEvents: 'http://www.w3.org/2001/xml-events',
  hta: 'urn:schemas-microsoft-com:hta',
  wordml: 'http://schemas.microsoft.com/office/word/2003/wordml',
  visio2003: 'http://schemas.microsoft.com/visio/2003/core',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  xsd: 'http://www.w3.org/2001/XMLSchema',
  rng: 'http://relaxng.org/ns/structure/1.0',
  exsltFunctions: 'http://exslt.org/functions',
} as const;

export interface MarkupAttribute {
  /** The name as written: lowercased by the HTML tokenizer, with its prefix in XML. */
  qname: string;
  local: string;
  /** Namespace URI, '' for none. */
  ns: string;
  value: string;
}

/** An element as either reading gives it, so one set of rules covers HTML and XML. */
export interface MarkupElement {
  qname: string;
  local: string;
  /** Namespace URI: the one the HTML tree construction puts it in, or the one its XML prefix resolves to. '' for none. */
  ns: string;
  attributes: MarkupAttribute[];
  /** Namespace declarations of an XML start tag, as prefix ('' for the default namespace) and URI. Empty for HTML. */
  namespaces: Array<[string, string]>;
  line: number;
  /** A void HTML element, or a tag written as empty: no content and no end tag follow. */
  empty: boolean;
  /** Read by the HTML tokenizer rather than the XML one. */
  html: boolean;
  /** Its position among the start tags of the document, from 0. Both passes number elements the same way. */
  index: number;
}

/** The value of the attribute with this namespace and local name, compared without case for HTML. */
export function attrValue(el: MarkupElement, local: string, ns = ''): string | undefined {
  for (const a of el.attributes) if (a.ns === ns && (el.html ? a.local.toLowerCase() === local.toLowerCase() : a.local === local)) return a.value;
  return undefined;
}

/** HTML elements with no content and no end tag. */
export const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'basefont',
  'bgsound',
  'br',
  'col',
  'embed',
  'frame',
  'hr',
  'image',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
