import { XmlCategory as C, XmlDetail as D, type XmlActionOverride, type XmlFinding, type XmlFindingAction } from './types';

interface Spec {
  action: XmlFindingAction;
  /**
   * May contain <key> placeholders filled from data, and <first|second> choices, which take the first alternative
   * whose {key} values are all set and not empty, or that names none. A filled value has control and format
   * characters replaced by "?", and one in a choice, such as a file name from the file, is cut to 60 characters.
   */
  description: string;
  weight: number;
}

const specs = new Map<string, Spec>();
function def(c: C, d: D, action: XmlFindingAction, weight: number, description: string): void {
  specs.set(`${c}/${d}`, { action, weight, description });
}

// FORMAT
def(C.Format, D.Unrecognized, 'reject', 0, 'The file is binary content, not HTML, XML, SVG or MHT');
def(C.Format, D.Unreadable, 'reject', 0, 'The file could not be read');
def(C.Format, D.Hta, 'reject', 0, 'The file is an HTML Application, which runs with full desktop rights');
def(C.Format, D.Office, 'reject', 0, 'The file is an Office document saved as XML, which this package does not read');
def(C.Format, D.Ebcdic, 'reject', 0, 'The file is XML in EBCDIC, which this package does not decode');
def(C.Format, D.Utf7, 'strip', 30, 'The file declares UTF-7, which older Internet Explorer decodes into markup other readers do not see');
def(C.Format, D.AmbiguousComment, 'strip', 20, 'A comment that HTML and XML readers end in different places');
def(C.Format, D.AmbiguousInstruction, 'strip', 20, 'A processing instruction that an HTML reader ends early');
def(C.Format, D.ConditionalComment, 'strip', 30, 'A conditional comment, which Internet Explorer and Outlook read as markup');
// XML
def(C.Xml, D.Doctype, 'info', 0, 'Document type declaration');
def(C.Xml, D.InternalSubset, 'strip', 20, 'A document type declaration with an internal subset, which declares entities and attribute defaults');
def(C.Xml, D.ExternalDtd, 'strip', 30, 'The document type names an external DTD, which a validating parser fetches');
def(C.Xml, D.ExternalEntity, 'strip', 40, 'A reference to an external entity, which a parser that loads external entities fetches');
def(C.Xml, D.XInclude, 'strip', 40, 'An XInclude element pulls in another file or part of this one');
def(C.Xml, D.Malformed, 'strip', 10, 'Not well-formed XML, so it was read as HTML, the way a browser reads a web page');
def(C.Xml, D.Encoding, 'strip', 10, 'XML in an encoding this package cannot read, or with bytes that are not valid in it, so it was read as HTML');
def(C.Xml, D.SchemaLocation, 'strip', 10, 'A schema location that is not relative, which a validating parser fetches');
// SCRIPT
def(C.Script, D.Element, 'strip', 70, 'A script element runs code');
def(C.Script, D.EventHandler, 'strip', 60, 'An event handler attribute runs code');
def(C.Script, D.Url, 'strip', 60, 'A javascript: or vbscript: URL runs code');
def(C.Script, D.Animation, 'strip', 60, 'An SVG animation sets a link or an event handler');
def(C.Script, D.Macro, 'strip', 80, 'Binary data in the document holds a VBA project, which Word loads with the document<: {name}|>');
// STYLE
def(C.Style, D.Expression, 'strip', 70, 'CSS expression(), which older Internet Explorer runs as script');
def(C.Style, D.Binding, 'strip', 60, 'CSS that binds behavior or an ActiveX filter to elements');
def(C.Style, D.Import, 'strip', 30, 'CSS @import loads another style sheet');
def(C.Style, D.RemoteUrl, 'strip', 20, 'CSS url() loads from outside the file');
def(C.Style, D.Escaped, 'info', 30, 'CSS names are written with escapes, a known way to hide them from scanners');
def(C.Style, D.MarkupInStyle, 'strip', 20, 'Elements inside a style element, which readers turn into a style sheet differently');
// EXTERNAL
def(C.External, D.Resource, 'strip', 10, 'An image, media file or other resource loads from outside the file');
def(C.External, D.Relative, 'info', 0, 'A resource loads from a relative address, beside the page');
def(C.External, D.PathTrick, 'strip', 40, 'A resource loads from a relative address whose path is written to read as another path<: {reason}|>');
def(C.External, D.Stylesheet, 'strip', 30, 'A style sheet or XSLT transform loads from outside the file');
def(C.External, D.Prefetch, 'strip', 10, 'The page asks the browser to contact a server ahead of time, or when a link is clicked');
def(C.External, D.Import, 'strip', 50, 'An HTML import loads another page with its scripts');
def(C.External, D.LocalFile, 'strip', 40, 'A resource loads from a local file');
def(C.External, D.NetworkPath, 'strip', 60, "A resource loads from a network share, which can leak the viewer's Windows credentials");
def(C.External, D.OtherScheme, 'strip', 40, 'A resource loads through a scheme other than http or https, which can start another program');
// LINK
def(C.Link, D.Safe, 'info', 0, 'Web or email link kept');
def(C.Link, D.FileUrl, 'strip', 60, 'A link opens a local file');
def(C.Link, D.NetworkPath, 'strip', 60, 'A link opens a network share');
def(C.Link, D.DataUrl, 'strip', 60, 'A link carries embedded data');
def(C.Link, D.OtherScheme, 'strip', 30, 'A link uses a scheme other than http, https or mailto');
def(C.Link, D.Credentials, 'strip', 40, 'A link hides its real host behind a user name');
def(C.Link, D.IpHost, 'strip', 40, 'A link points at a raw IP address');
def(C.Link, D.LookalikeHost, 'strip', 40, "A link's host uses punycode or mixed scripts");
def(C.Link, D.EncodedHost, 'strip', 40, "A link's host is percent-encoded");
def(C.Link, D.TextMismatch, 'strip', 40, "A link's text or title names a different site");
def(C.Link, D.Relative, 'info', 0, "A relative link, which resolves against the page's own address");
def(C.Link, D.PathTrick, 'strip', 40, 'A relative link whose path is written to read as another path<: {reason}|>');
// FORM
def(C.Form, D.Submit, 'strip', 40, 'A form sends its data to a URL');
def(C.Form, D.Password, 'info', 20, 'A password field');
// NAVIGATION
def(C.Navigation, D.Refresh, 'strip', 40, 'A meta refresh sends the browser to an address that is not relative, or to one readers can take differently');
def(C.Navigation, D.RelativeRefresh, 'info', 0, 'A meta refresh reloads the page or moves to a relative address beside it');
def(C.Navigation, D.Base, 'strip', 30, 'A base address that is not relative moves every relative link and resource to it');
def(C.Navigation, D.RelativeBase, 'info', 0, "A relative base address, which keeps relative links and resources on the page's own site");
def(C.Navigation, D.PathTrick, 'strip', 40, 'A meta refresh or base address at a relative address whose path is written to read as another path<: {reason}|>');
def(C.Navigation, D.SetCookie, 'strip', 30, 'A meta element sets a cookie');
// EMBEDDED
def(C.Embedded, D.Iframe, 'strip', 40, 'An inline frame shows another page inside this one');
def(C.Embedded, D.Frame, 'strip', 40, 'A frame shows another page');
def(C.Embedded, D.Object, 'strip', 60, 'An object element loads a plugin, another document or an ActiveX control');
def(C.Embedded, D.Embed, 'strip', 60, 'An embed element loads a plugin or another document');
def(C.Embedded, D.Applet, 'strip', 70, 'A Java applet');
def(C.Embedded, D.NoPlugin, 'strip', 30, '<Embedded file "{name}"|An embedded file> (<{sniffed}|{type}|unknown type>) removed. No plugin accepts this type');
def(
  C.Embedded,
  D.TypeMismatch,
  'info',
  40,
  'The types of <embedded file "{name}"|an unnamed embedded file> disagree: <its name says {nameType}|its name has no known extension>, <it is declared {declared}|it has no declared type>, and <its content looks like {sniffed}|its content is not recognized>',
);
def(C.Embedded, D.PluginPassed, 'info', 0, 'Embedded file kept by plugin <plugin> with nothing removed');
def(C.Embedded, D.PluginScrubbed, 'info', 0, 'Embedded file cleaned and kept by plugin <plugin>');
def(C.Embedded, D.PluginFailed, 'strip', 30, 'Plugin <plugin> failed, so the embedded file was removed');
def(C.Embedded, D.PluginRemoved, 'strip', 0, 'Embedded file removed by plugin <plugin>');
// SVG
def(C.Svg, D.ForeignObject, 'strip', 20, 'An SVG foreignObject holds HTML inside the drawing');
def(C.Svg, D.UseExternal, 'strip', 30, 'An SVG use element copies content from another file');
def(C.Svg, D.UseAmplification, 'strip', 40, 'SVG use elements copy each other into <total> elements, enough to freeze a renderer');
// XSLT
def(C.Xslt, D.Script, 'strip', 80, 'An XSLT stylesheet carries script that the transform runs');
def(C.Xslt, D.ExtensionFunction, 'strip', 60, 'An XSLT expression calls an extension function, which can run code or reach files');
def(C.Xslt, D.ExtensionElement, 'strip', 60, 'An XSLT extension element, which can run code or write files');
def(C.Xslt, D.Document, 'strip', 40, 'An XSLT expression reads another file');
def(C.Xslt, D.Include, 'strip', 40, 'An XSLT stylesheet includes or imports another file');
def(C.Xslt, D.ResultDocument, 'strip', 50, 'An XSLT stylesheet writes another output file');
def(C.Xslt, D.UnescapedOutput, 'strip', 30, 'An XSLT instruction writes text as markup, which can put script in the result');
def(C.Xslt, D.Evaluate, 'strip', 40, 'An XSLT stylesheet evaluates an expression built while it runs, which can call any function the processor offers');
// SERVER
def(C.Server, D.Ssi, 'strip', 60, 'A server-side include directive, which a web server with SSI turned on runs');
def(C.Server, D.Esi, 'strip', 50, 'An Edge Side Includes element or comment, which a caching server that processes ESI runs');
def(C.Server, D.Code, 'strip', 40, 'Server-side code, such as PHP, ASP or JSP, which a web server runs');
// MHT
def(C.Mht, D.Malformed, 'reject', 0, 'The MHT file has no parts that can be read');
def(C.Mht, D.HiddenData, 'strip', 10, 'Data outside the parts of the MHT file, which a reader does not show');
// METADATA
def(C.Metadata, D.Stripped, 'info', 0, 'Metadata removed because the caller turned on metadata stripping');
// LIMIT
def(C.Limit, D.FileSize, 'reject', 0, 'The file exceeds the file size limit');
def(C.Limit, D.Depth, 'reject', 0, 'Elements, or the parts of an MHT file, nest deeper than the depth limit');
def(C.Limit, D.TokenSize, 'reject', 0, 'A tag, comment or other token exceeds the token size limit');
def(C.Limit, D.EntityDepth, 'reject', 0, 'XML entity references nest deeper than the entity depth limit');
def(C.Limit, D.EntityExpansions, 'reject', 0, 'XML entities and attribute defaults expand more often than the expansion limit allows');
def(C.Limit, D.EntitySize, 'reject', 0, 'XML entities and attribute defaults expand into more text than the entity size limit allows');
def(C.Limit, D.Parts, 'reject', 0, 'The MHT file has more parts than the part limit');
def(C.Limit, D.DecodedSize, 'reject', 0, 'An MHT part or data: URL decodes larger than the decoded size limit');
def(C.Limit, D.NestingDepth, 'reject', 0, 'The file sits deeper in the upload than the nesting depth limit');
def(C.Limit, D.Time, 'reject', 0, 'The file exceeds the time limit');
// PROCESSING
def(C.Processing, D.MemoryFallback, 'info', 0, '<part> was too large for memory and went through a temporary file');
def(C.Processing, D.VerificationFailed, 'reject', 0, 'The defused output did not pass its own inspection, so nothing was written');
def(C.Processing, D.ContentRemoved, 'strip', 20, 'Content was removed that no other finding names');

/** The built-in spec for a kind of finding, or undefined for a kind xml-defuse does not make, such as one from another package. */
export function findingSpec(category: string, detail: string): Spec | undefined {
  return specs.get(`${category}/${detail}`);
}

/** The spec of a kind xml-defuse makes itself, which always has one. */
function ownSpec(category: C, detail: D): Spec {
  const s = findingSpec(category, detail);
  if (!s) throw new Error(`No finding spec for ${category}/${detail}`);
  return s;
}

export function allFindingSpecs(): Array<{ category: C; detail: D } & Spec> {
  return [...specs.entries()].map(([k, s]) => {
    const [category, detail] = k.split('/') as [C, D];
    return { category, detail, ...s };
  });
}

export class FindingFactory {
  constructor(private readonly overrides: XmlActionOverride[] = []) {}

  actionFor(category: C, detail: D): XmlFindingAction {
    const exact = this.overrides.find(o => o.category === category && o.detail === detail);
    if (exact) return exact.action;
    const byCategory = this.overrides.find(o => o.category === category && o.detail === undefined);
    if (byCategory) return byCategory.action;
    return ownSpec(category, detail).action;
  }

  make(category: C, detail: D, location?: string, data?: Record<string, string | number>): XmlFinding {
    const spec = ownSpec(category, detail);
    // Values can come from the file, so the description shows no control or direction characters from them.
    const shown = (v: string | number) => String(v).replace(/[\p{Cc}\p{Cf}]/gu, '?');
    const description = spec.description.replace(/<([^<>]+)>/g, (m, body: string) => {
      if (/^[a-z]+$/.test(body)) return data?.[body] !== undefined ? shown(data[body]) : m;
      for (const alt of body.split('|')) {
        let missing = false;
        const filled = alt.replace(/\{([a-zA-Z]+)\}/g, (_, key: string) => {
          const v = data?.[key];
          if (v === undefined || v === '') missing = true;
          const s = shown(v ?? '');
          return s.length > 60 ? `${s.slice(0, 57)}...` : s;
        });
        if (!missing) return filled;
      }
      return m;
    });
    const f: XmlFinding = { category, detail, description, action: this.actionFor(category, detail) };
    if (location !== undefined) f.location = location;
    if (data !== undefined && Object.keys(data).length) f.data = data;
    return f;
  }
}
