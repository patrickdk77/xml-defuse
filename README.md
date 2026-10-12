# xml-defuse

Sanitize HTML, XHTML, SVG, XML, XSLT and MHT files before you store or serve them. xml-defuse finds scripts, event handlers, script URLs, external entities, XInclude, XSLT extensions, frames, plugins, forms, redirects, CSS that runs or loads, server-side includes and the other active content these formats carry. It scores the risk and writes a clean copy with that content removed. This is content disarm and reconstruction, or CDR.

It has no runtime dependencies, streams the file in chunks, and runs the same code for buffers, local files and S3 objects. It follows the shapes of [pdf-defuse](https://github.com/patrickdk77/pdf-defuse), so the two fit the same defuse family.

```
npm install @patrickdk77/xml-defuse
```

Node 18 or later.

## Quick start

```js
const { inspectXml, disarmXml } = require('@patrickdk77/xml-defuse');

const report = await inspectXml(bytes);
report.status;   // 'clean', 'strippable' or 'rejected'
report.risk;     // 'NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL' or 'UNKNOWN'
report.score;    // 0 to 100, null when the file could not be inspected
report.format;   // 'html', 'xhtml', 'svg', 'xslt', 'xml', 'mht', or '' when not recognized
report.encoding; // the encoding the text was read in, such as 'utf-8' or 'windows-1252'
report.findings; // [{ category, detail, description, action, location, data, attachment, weight }]

const result = await disarmXml(bytes);
if (result.status !== 'rejected') save(result.bytes);
```

ES modules work too: `import { disarmXml } from '@patrickdk77/xml-defuse'`.

`disarmXml` returns `status`, which is `'clean'`, `'defused'` or `'rejected'`. `before` holds the inspection of the upload, `after` the inspection of the output, and `removed` the findings whose content went.

### Files and S3

The engine reads through a source with `size()` and `read(offset, length)`, and writes to a sink that only appends, with `write(chunk)` and `close()`. A buffer, a local file and an S3 object all fit. `disarmXmlSource` copies the source once, start to end, and works from that copy, so a source that changes during the run cannot get anything past the inspection. `inspectXmlSource` reads the source directly. Both call the source's `close()`, if it has one, when the run ends.

```js
const { disarmXmlSource, fileSource, fileSink, writableSink } = require('@patrickdk77/xml-defuse');

await disarmXmlSource(fileSource('upload.svg'), fileSink('clean.svg'));
```

`bufferSource`, `bufferSink`, `fileSource`, `fileSink` and `writableSink` are the same as in pdf-defuse, and the S3 example in its README works here unchanged. A `read` must return exactly the bytes asked for, or fewer only at the end of the source. An error a source throws fails the run, and the call throws it. It is never a verdict on the file.

Nothing reaches the sink unless the output passed its own inspection. A rejected file leaves the sink untouched. If copying to the sink fails, the engine calls the sink's optional `abort(error)` instead of `close()`, so a partial output does not look whole.

## How a file is read

xml-defuse picks the reading from the first 4 KiB of the file.

- MHT, when the file starts with MIME headers that name a multipart body, or with a `MIME-Version` header and a markup body such as `text/html`. Each part is decoded from base64 or quoted-printable. Markup parts and CSS parts are read here. Every other part is a file inside the file and goes to the plugins.
- XML, when the file starts with an XML declaration, its first element declares a namespace, its document type names something other than `html`, or its first element is not one a web page usually starts with.
- HTML otherwise, and whenever the HTML5 declaration `<!DOCTYPE html>` comes before the first element and no XML declaration comes before it. Text with no markup at all is read as HTML too, since a browser shows it as a page.

XML that is not well-formed is read again as HTML, the way a browser reads a page it was served. XML/MALFORMED reports this when the file said it was XML, by a declaration, a namespace on a first element other than `html`, or its document type. XML/ENCODING does the same for XML in an encoding the XML reading refuses.

Binary content is refused with FORMAT/UNRECOGNIZED. That covers a NUL byte in the first 4 KiB of a file that is not UTF-16, and the signatures of PDF, ZIP, PNG, JPEG, GIF, OLE and executable files.

XML in EBCDIC, which starts with the bytes 4C 6F A7 94 of an XML declaration, is refused with FORMAT/EBCDIC. xml-defuse does not decode EBCDIC, and an XML reader that does would read the file as XML, entities and all, so it is neither text nor a page to read as HTML.

An HTML Application runs with full desktop rights, so it is rejected and never cleaned. FORMAT/HTA reports a file that holds an `hta:application` element, and any file whose name ends in `.hta`. The library calls see a name only when the `name` option gives one. The command-line tool and `xmlPlugin` pass the file's name.

An Office document saved as one XML file, a flat OpenDocument file or a Flat OPC package, is rejected with FORMAT/OFFICE. office-defuse reads those, and `xmlPlugin` does not accept them, so a router hands them to office-defuse.

### XML

The XML reading is the tokenizer office-defuse uses, with its limits. It reads XML 1.0 with namespaces and refuses anything that is not well-formed. It reads UTF-8 and UTF-16, by byte order mark or by the pattern of the first bytes, and any encoding that keeps ASCII as it is and that Node's `TextDecoder` reads, when the XML declaration names it. It never loads an external DTD or an external entity. It reads the internal subset as a processor that reads no external parameter entity does, expands internal entities within the entity limits, and applies the attribute defaults the subset declares.

### HTML

The HTML tokenizer follows the tokenizer states of the WHATWG HTML Standard, section 13.2.5, all of them. That includes the script data escape states, character references with the standard's table and its rules for legacy names and numeric references, and comments with their abrupt and odd endings. Behind it sits the part of the tree construction stage that decides how the tokenizer reads what comes next and which namespace each element is in:

- the stack of open elements, with the namespace of each,
- SVG and MathML foreign content, with the tags that leave it, the integration points that read HTML inside it, and the adjusted names of SVG elements and attributes,
- the switch to raw text, RCDATA, script data or PLAINTEXT after `title`, `textarea`, `style`, `xmp`, `iframe`, `noembed`, `noframes`, `noscript`, `script` and `plaintext`,
- CDATA sections, read only in foreign content,
- the end tags common start tags imply, for `p`, `li`, `dd`, `dt`, headings, table cells and rows, `option`, `button`, `a`, `nobr` and `select`, and table end tags looked up in table scope.

Where it differs from a browser:

- It does not create the `html`, `head` and `body` elements a browser implies, and it has no insertion modes. A tag a browser ignores inside a table, a select or a frameset is an element here, so its attributes are checked.
- It does no foster parenting and no adoption agency. Misnested formatting elements stay where the file put them.
- It reads `template` contents as ordinary content.
- It reads with scripting on, so a `noscript` element holds raw text, and then reads that text again as a browser with scripting off reads it. The rules check both readings.
- It picks the encoding as the WHATWG encoding sniffing algorithm does, by a byte order mark, then the charset of an MHT part, then a meta element in the first 1024 bytes, then the encoding an XML declaration names. Without any of these it reads UTF-8 when the first 64 KiB are valid UTF-8, and windows-1252 otherwise, where a browser runs a detector. It never decodes UTF-7, which no browser decodes now.

The differences cannot hide markup in the output, because of how the output is written. Every tag in it is one the rules saw, with its attributes written in double quotes and escaped. Text never holds a `<` that starts markup. Text and attribute values write it as a character reference, a style sheet as the CSS escape `\3c `, and other raw text as `&lt;`. A reader that builds a different tree from the output still finds only what the rules checked. Then the output check, below, reads the output in both syntaxes.

## What it removes and what it keeps

Each finding below has a default action. `strip` removes what the finding names, `reject` refuses the file, and `info` keeps it and reports it.

| Finding | Action | Weight | What it names |
|---|---|---|---|
| FORMAT/UNRECOGNIZED | reject | 0 | Binary content |
| FORMAT/UNREADABLE | reject | 0 | A file the reading failed on in a way it did not expect |
| FORMAT/HTA | reject | 0 | An HTML Application |
| FORMAT/OFFICE | reject | 0 | An Office document saved as XML |
| FORMAT/EBCDIC | reject | 0 | XML in EBCDIC, which xml-defuse does not decode |
| FORMAT/UTF7 | strip | 30 | A declaration of UTF-7, which older Internet Explorer decodes. The output is UTF-8 whatever the action |
| FORMAT/AMBIGUOUS_COMMENT | strip | 20 | An XML comment an HTML reader ends in another place, such as `<!-->` |
| FORMAT/AMBIGUOUS_INSTRUCTION | strip | 20 | An XML processing instruction whose data holds `>` |
| FORMAT/CONDITIONAL_COMMENT | strip | 30 | `<!--[if IE]>` comments and `<![if]>` markers, which Internet Explorer and Outlook read as markup |
| XML/DOCTYPE | info | 0 | A document type declaration in an XML file that names a DTD on www.w3.org, or none |
| XML/INTERNAL_SUBSET | strip | 20 | The internal subset. Entities are expanded and defaults applied in the output either way |
| XML/EXTERNAL_DTD | strip | 30 | The identifiers of a DTD on any other host |
| XML/EXTERNAL_ENTITY | strip | 40 | A reference to an external entity, general or parameter |
| XML/XINCLUDE | strip | 40 | An XInclude `include` element, with its fallback |
| XML/MALFORMED | strip | 10 | XML that is not well-formed, read as HTML |
| XML/ENCODING | strip | 10 | XML the XML reading cannot decode, read as HTML |
| XML/SCHEMA_LOCATION | strip | 10 | `xsi:schemaLocation`, `xsi:noNamespaceSchemaLocation`, the `schemaLocation` of an XML Schema import or include, and an `xml-model` instruction, at an address that is not relative, unless every target is on www.w3.org. Also an `xml-model` instruction whose pseudo-attributes do not parse |
| SCRIPT/ELEMENT | strip | 70 | `script` in HTML, SVG and XHTML, SVG `handler` and XML Events `listener` |
| SCRIPT/EVENT_HANDLER | strip | 60 | Any `on` attribute of an HTML, SVG or MathML element, and the known handler names on any other element |
| SCRIPT/URL | strip | 60 | A `javascript:`, `vbscript:`, `livescript:` or `mocha:` URL in a link, a resource, a form action, a refresh or CSS |
| SCRIPT/MACRO | strip | 80 | A Word 2003 XML `w:binData` element holding an ActiveMime blob, the form Word keeps a VBA project in as `editdata.mso`. The element goes whatever the plugins decide |
| SCRIPT/ANIMATION | strip | 60 | An SVG animation that sets `href` or a handler, or that sets any value to a script or data URL |
| STYLE/EXPRESSION | strip | 70 | CSS `expression()`, read with comments and escapes removed and wide letters folded |
| STYLE/BINDING | strip | 60 | `behavior`, `-moz-binding` and ActiveX `progid:` filters |
| STYLE/IMPORT | strip | 30 | `@import` |
| STYLE/REMOTE_URL | strip | 20 | A CSS `url()`, `image-set()` or similar that loads from outside the file |
| STYLE/ESCAPED | info | 30 | CSS names written with escapes |
| STYLE/MARKUP_IN_STYLE | strip | 20 | An element inside a style element that holds markup, as in XML and in SVG |
| EXTERNAL/RESOURCE | strip | 10 | An image, media file, icon or other resource that loads from a web address |
| EXTERNAL/RELATIVE | info | 0 | An image, style sheet, SVG `use` file or other resource at a relative address, such as `img/a.png` or `icons.svg#home`, which loads from beside the page. Also `ping`, `manifest`, a CSS `xml-stylesheet` instruction and a schema location at a relative address |
| EXTERNAL/PATH_TRICK | strip | 40 | A resource at a relative address whose path is written to read as another path. `reason` says how |
| EXTERNAL/STYLESHEET | strip | 30 | A linked style sheet that is not at a relative address, and an `xml-stylesheet` instruction that loads XSLT, loads CSS that is not at a relative address, or has pseudo-attributes that do not parse |
| EXTERNAL/PREFETCH | strip | 10 | Prefetch, preload and preconnect links, `ping` and `manifest`, at addresses that are not relative |
| EXTERNAL/IMPORT | strip | 50 | An HTML import |
| EXTERNAL/LOCAL_FILE | strip | 40 | A resource on a local file |
| EXTERNAL/NETWORK_PATH | strip | 60 | A resource on a network share |
| EXTERNAL/OTHER_SCHEME | strip | 40 | A resource through any other scheme, such as `ms-its:` or `mhtml:` |
| LINK/SAFE | info | 0 | An http, https or mailto link |
| LINK/FILE_URL, NETWORK_PATH, DATA_URL, OTHER_SCHEME | strip | 60, 60, 60, 30 | Links to local files, network shares, embedded data and other schemes |
| LINK/CREDENTIALS, IP_HOST, LOOKALIKE_HOST, ENCODED_HOST | strip | 40 | Links built to mislead, as pdf-defuse checks them |
| LINK/TEXT_MISMATCH | strip | 40 | A link whose text or title names a different site |
| LINK/RELATIVE | info | 0 | A relative link, such as `other.html` or `../up/page.html`, which resolves against the page's own address |
| LINK/PATH_TRICK | strip | 40 | A relative link whose path is written to read as another path. `reason` says how |
| FORM/SUBMIT | strip | 40 | A `form` element, whose tags go and whose fields stay, a `formaction` attribute, and `isindex` |
| FORM/PASSWORD | info | 20 | A password field |
| NAVIGATION/REFRESH | strip | 40 | A meta refresh to an address that is not relative, or one readers can take differently |
| NAVIGATION/RELATIVE_REFRESH | info | 0 | A meta refresh that reloads the page or moves to a relative address |
| NAVIGATION/BASE | strip | 30 | A `base` element or `xml:base` whose address is not relative |
| NAVIGATION/RELATIVE_BASE | info | 0 | A `base` element or `xml:base` at a relative address, such as `docs/` |
| NAVIGATION/PATH_TRICK | strip | 40 | A meta refresh or base address at a relative address whose path is written to read as another path. `reason` says how |
| NAVIGATION/SET_COOKIE | strip | 30 | A meta element that sets a cookie |
| EMBEDDED/IFRAME | strip | 40 | `iframe`, `portal` and `fencedframe` |
| EMBEDDED/FRAME | strip | 40 | `frame`, and the tags of `frameset` |
| EMBEDDED/OBJECT, EMBED, APPLET | strip | 60, 60, 70 | `object` and `applet`, whose tags and parameters go and whose fallback content stays, and `embed` |
| EMBEDDED/NO_PLUGIN | strip | 30 | A file inside the file that no plugin accepts |
| EMBEDDED/TYPE_MISMATCH | info | 40 | A file inside whose declared type, name and content disagree |
| EMBEDDED/PLUGIN_PASSED, PLUGIN_SCRUBBED | info | 20, 10 | A file inside that a plugin kept |
| EMBEDDED/PLUGIN_FAILED, PLUGIN_REMOVED | strip | 0 | A file inside that a plugin failed on or removed |
| SVG/FOREIGN_OBJECT | strip | 20 | `foreignObject` |
| SVG/USE_EXTERNAL | strip | 30 | A `use` element that copies from a file that is not beside the page, such as one on another site or in a data: URL |
| SVG/USE_AMPLIFICATION | strip | 40 | `use` elements that copy each other into more than a million elements. Every same-file `use` goes |
| XSLT/SCRIPT | strip | 80 | `msxsl:script`, `xsl:script`, Xalan `component` and `script`, EXSLT `func:script` |
| XSLT/EXTENSION_FUNCTION | strip | 60 | A call to a function in a namespace that is not a standard one and that the stylesheet does not define itself |
| XSLT/EXTENSION_ELEMENT | strip | 60 | An element in a namespace the stylesheet declares as an extension |
| XSLT/DOCUMENT | strip | 40 | `document()`, `doc()`, `unparsed-text()`, `collection()`, `environment-variable()`, `transform()` and similar, and `xsl:source-document`, `xsl:stream` and `xsl:merge-source` |
| XSLT/INCLUDE | strip | 40 | `xsl:include`, `xsl:import`, `xsl:import-schema` and `xsl:use-package` |
| XSLT/RESULT_DOCUMENT | strip | 50 | `xsl:result-document` |
| XSLT/UNESCAPED_OUTPUT | strip | 30 | `disable-output-escaping`, and an `xsl:output-character` whose string holds markup. On `xsl:text` it counts only when the text, read as HTML, holds something another finding would change |
| XSLT/EVALUATE | strip | 40 | `xsl:evaluate` |
| SERVER/SSI | strip | 60 | Server-side include directives such as `<!--#exec cmd="..."-->` |
| SERVER/ESI | strip | 50 | The tags of Edge Side Includes elements, and `<!--esi ...-->` comments |
| SERVER/CODE | strip | 40 | PHP instructions, ASP and JSP `<% %>`, which the HTML output escapes whatever the action, and JSP elements |
| MHT/MALFORMED | reject | 0 | An MHT file with no part to read |
| MHT/HIDDEN_DATA | strip | 10 | Text outside the parts, other than the notices mail programs and Word write there |
| METADATA/STRIPPED | info | 0 | What `stripMetadata` removed |
| LIMIT/* | reject | 0 | A limit stopped the run |
| PROCESSING/MEMORY_FALLBACK | info | 0 | An MHT part decoded to a temporary file |
| PROCESSING/VERIFICATION_FAILED | reject | 0 | The output failed its own check |
| PROCESSING/CONTENT_REMOVED | strip | 20 | Content the rewrite removed that no other finding names, such as an attribute whose name holds a quote |

XSLT expressions are read in the attributes of XSLT instructions, in attribute value templates, in attributes in the XSLT namespace such as `xsl:use-when`, and in text value templates where `expand-text` is on. String literals and comments are left out, and a URI-qualified name such as `Q{uri}name()` and a named function reference such as `prefix:name#2` count as calls.

Kept: text, structure, images in data: URLs and MHT parts that the plugins keep, inline styles and style sheets without the declarations a finding names, SVG drawing elements and their same-file references, XSLT templates and expressions, and safe links.

Relative addresses are how web pages link to their own pages, images and style sheets, so whatever sits at a relative address stays by default. That covers links, resources, style sheets, `@import`, SVG `use`, `ping`, `manifest`, a CSS `xml-stylesheet` instruction, a schema location, a meta refresh and a `base` address. An empty address and a fragment name the page itself, so they count as relative. Setting a relative finding to `strip` removes them.

A meta refresh stays only when every address a reader can take from its content is relative. A browser takes the text after `url=`, cut at a closing quote, or the text after the separator when there is no `url=`. Older readers took the text after any `url=`, so `0; url=a.html;url=https://example.net/` is NAVIGATION/REFRESH.

Climbing from the start, as `../img/a.png` does, is ordinary. PATH_TRICK takes the relative addresses written to read as another path: a control character, which a browser drops, a backslash, which a browser reads as a slash, an encoded dot, slash, backslash or NUL in the path, a segment of only dots and spaces, which Windows reads as `..` or as nothing, and a path that names a folder and then climbs above where it started, such as `a/../../etc/passwd`.

Two loads go wherever they point, because they run code: an HTML import, EXTERNAL/IMPORT, and an `xml-stylesheet` instruction that loads XSLT, EXTERNAL/STYLESHEET. When an override keeps a `base` address that is not relative, the relative addresses after it resolve against that base, so they count as leading where it points.

An `xml-stylesheet` or `xml-model` instruction is read by its pseudo-attributes, as the W3C recommendation on associating style sheets writes them: a name, `=`, a quoted value that may hold character references and the five predefined entities, and white space before the next one. So `title="href='a.css'"` is a title, not an address. An instruction that does not parse that way, such as one with two `href`s or a `<` in a value, gives the rule no address it can trust, and is EXTERNAL/STYLESHEET or XML/SCHEMA_LOCATION.

Each rule decides only for what it names. An `iframe` kept by an override to `info` still loses a `src` that EXTERNAL/RESOURCE strips, and a `form` kept the same way keeps its fields whatever happens to its `action`.

Every file that is not rejected is rewritten, so the output holds only what xml-defuse read. That includes a file with nothing to remove, whose status stays `clean`.

Some content goes whatever an override says, and its finding then shows `strip`. That covers an ambiguous comment or instruction, data outside the parts of an MHT file, a file inside that no plugin can decode or that a plugin failed on or removed, and CONTENT_REMOVED.

An override to `strip` removes the content for LINK/SAFE, XML/DOCTYPE and EMBEDDED/TYPE_MISMATCH. FORM/PASSWORD, STYLE/ESCAPED and the PLUGIN_PASSED and PLUGIN_SCRUBBED findings name nothing the rewrite can remove. A `strip` override on one of them leaves the finding in the output, so the output fails its own check and the upload is rejected.

## The rewrite

An HTML output is UTF-8 and starts with a UTF-8 byte order mark, which every browser reads before any other encoding declaration. Meta elements that declare an encoding are rewritten to say UTF-8. End tags appear where the file wrote them, and elements in SVG and MathML always get one, since XML readers need them. A file that looked like XML but was read as HTML starts with `<!DOCTYPE html>` in place of its own declaration, so its output is read as HTML again.

An XML output is UTF-8. It starts with an XML declaration when the file had one or was in another encoding. Each element declares the namespaces it needs, including those an element left out of the output declared. Entity references are expanded, CDATA sections are written as text, and white space in attribute values is written as character references so it survives. An empty XHTML element that is not void in HTML, such as `<div/>`, gets an end tag, so an HTML reader does not leave it open.

An MHT output keeps the headers and the structure of parts, with new boundaries. Every kept part is written in base64, markup and CSS parts in UTF-8 with a `charset` parameter that says so. References to a part that went go with it.

Defusing an output again gives the same bytes, and inspecting it gives `clean`.

## The output check

Before anything reaches your sink, xml-defuse inspects its own output twice. The first reading uses the output's own syntax. The second uses the other one. An XML output is read as HTML. An HTML output is read as XML up to its first error, as a browser shows a page it could parse that far. An MHT output is read whole as HTML. Any finding other than `info` in either reading rejects the file with PROCESSING/VERIFICATION_FAILED, which lists what was found. An override that keeps an internal subset can hit this, since an HTML reader ends the declaration at the first `>` in it.

## Findings

Every finding has `category` and `detail`, which name its kind, and `description`, a plain sentence that is safe to show the uploader. `location` gives the line and the element, such as `line 12, <img onerror>`, with an MHT part's number in front. `data` holds the element, the attribute, the URL and other values from the file, cut to a few hundred characters. A description cuts a value from the file to 60 characters and replaces control and direction characters with `?`.

The enums are exported as `XmlCategory` and `XmlDetail`, and `allFindingSpecs()` lists every pair with its default action, description and weight.

Past 200 findings of one kind, one more finding with the location `additional occurrences` counts the rest in `data.count`.

A finding from inside a file carries `attachment`, the file's name or `unnamed file`, with ` > ` between nesting levels, and its `location` starts with where that file sits.

## Scoring

The score runs from 0 to 100. The highest weight counts in full and every other kind adds a quarter of its weight, so repeats of one finding stay minor. Some combinations add more:

- a password field with a form that sends data, 20,
- a script with an object, embed or applet, 15,
- a script with escaped CSS names, UTF-7 or conditional comments, 15,
- a script with a form that sends data or a meta refresh, 10.

`scoreWeights` comes first, then the built-in weights. A kind xml-defuse does not know, such as one a plugin from another package returned, scores at its `weight`, or 0 without one. The bands are NONE at 0, LOW from 1, MEDIUM from 25, HIGH from 50 and CRITICAL from 80, and `scoreBands` changes them.

A run that stops before it has seen the whole file rejects it with a null score and the UNKNOWN level, whatever `actionOverrides` say. That happens at a limit, at binary content, at an MHT file with no part to read, and at a failure the reading did not expect.

## Options

| Option | Default | Purpose |
|---|---|---|
| `limits` | see below | Limits on the file and the run |
| `stripMetadata` | `false` | Remove comments, processing instructions other than `xml-stylesheet`, `xml-model` and PHP, SVG `metadata`, elements and attributes in the Inkscape, Sodipodi, Adobe, Sketch, Dublin Core, Creative Commons and RDF namespaces, and meta elements that name an author, a generator or similar |
| `actionOverrides` | none | Change the action for a category, or for a category and detail |
| `scoreWeights`, `scoreBands` | built in | Change the scoring |
| `filePlugins` | none | Keep chosen files inside the file |
| `tempDir` | `os.tmpdir()` | Where temporary files go |
| `name` | none | The upload's file name. Only the HTML Application check reads it |
| `memoryThreshold` | 8 MiB | `disarmXmlSource` keeps its copy of the upload and its output in memory up to this size, and in temporary files above it. Each decoded MHT part above it goes through a temporary file, and the copies plugins rewrote share this much memory |

There is no password option. MHT carries nothing encrypted.

| Limit | Default | Counts |
|---|---|---|
| `fileSize` | none | Bytes in the upload |
| `depth` | 256 in XML, 4096 in HTML | Element nesting, counting the elements HTML leaves open and the elements in the text of a noscript element, and the nesting of MHT multipart bodies |
| `tokenSize` | 16 Mi | Characters in one tag, comment, processing instruction, CDATA section or document type declaration, and in the text of a style or noscript element |
| `entityDepth` | 16 | XML entity references inside entity text |
| `entityExpansions` | 100,000 | XML entity references and attribute defaults expanded in the run |
| `entitySize` | 16 Mi | Characters those expansions add |
| `parts` | 10,000 | Parts in an MHT file, nested ones included |
| `decodedBytes` | 512 MiB | Decoded bytes of one MHT part or data: URL |
| `nestingDepth` | none | How deep a file may sit in the upload. The upload is at 0 |
| `timeMs` | none | The whole run |

To reject every file that has a script instead of removing the scripts:

```js
await disarmXml(bytes, { actionOverrides: [{ category: 'SCRIPT', action: 'reject' }] });
```

## Plugins

These files inside the file go to the file plugins:

- a data: URL that loads, such as an image source, a `srcset` entry, a CSS `url()`, an SVG `href` or an `object` `data`,
- the page in an `iframe` `srcdoc`,
- an MHT part that is not markup or CSS,
- the base64 file in a Word 2003 XML `w:binData` element, such as a picture or `editdata.mso`, or in a Visio 2003 XML `ForeignData` element. The `w:name` attribute names the file, and a `ForeignData` element's `CompressionType` or `ForeignType` gives its type.

A data: URL in a link is a LINK/DATA_URL finding instead. A file no plugin accepts goes, with EMBEDDED/NO_PLUGIN. The first plugin that accepts a file handles it. It scrubs the file, passes it through, or removes it after all. If it throws, or scrubs and writes nothing, the file goes.

A file a plugin keeps stays where it was. A scrubbed data: URL is written again in base64 with the plugin's bytes, a scrubbed `srcdoc` holds the plugin's bytes as text, and a scrubbed MHT part or binary data element holds them in base64.

```js
const { disarmXml, passThrough, xmlPlugin } = require('@patrickdk77/xml-defuse');

await disarmXml(bytes, {
  filePlugins: [
    xmlPlugin(),                          // defuse SVG, HTML and XML inside the file
    passThrough(['image/png', '.gif']),   // keep PNG images and .gif files unchanged
  ],
});
```

`xmlPlugin(options)` runs a file through this package again with those options. Built without options, it takes the options of the xml-defuse run that found the file, or none when another package found it. It accepts a file by its content, whatever its name says, when that content starts as HTML, XML, SVG or MHT. It does not accept an Office document saved as XML. It passes the file's name on, so a file named `.hta` is removed with FORMAT/HTA among its findings.

`passThrough` takes MIME types and file name extensions, as pdf-defuse's does. It does not read the content.

Before any plugin sees a file, the type check compares its declared type, the type its name implies and the type its content sniffs as. EMBEDDED/TYPE_MISMATCH reports a disagreement. It is `info` by default, and an override to `strip` removes the file before any plugin sees it. Plugins never check whether the types agree.

`process` can return `{ result, findings, outputFindings }`. `findings` describe the file as it arrived and go into the report of the file that holds it, with `attachment` set and `reject` turned into `strip`, since the inner file goes and the upload stays. `outputFindings` describe the bytes the plugin kept and go into the output's report. The output check knows a kept file again by a hash of its bytes.

## The defuse family

xml-defuse fits the contract pdf-defuse describes under The defuse family. A master package builds one router over each package's plugin, puts that router in every package's `filePlugins`, and sends the upload to the router at depth 0.

- `detectXml(bytes, options)` and `detectXmlSource(source, options)` tell a router whether xml-defuse reads a file and in which format: HTML, XHTML, SVG, XSLT, XML or MHT. They read the first 64 KiB and decide the way the inspection picks its reader, by the markup or MIME headers at the start and, for XML, the namespace the root element's start tag declares. They do not claim an Office document saved as XML, or text with no markup at the start. They claim XML in EBCDIC, which the inspection refuses. The full read can still name a file differently. XML that does not parse is read as HTML, and a namespace that an entity spells out is resolved only there. `xmlPlugin` takes what detection finds, and `detectXmlSource` leaves the source open.
- The plugin context holds `depth`, the depth of the file itself, and `deadline`, the `Date.now()` value the whole upload must finish by. `xmlPlugin` runs a file at the depth in its context and checks `limits.nestingDepth` against it.
- Findings are `DefuseFinding` objects, with `category` and `detail` as plain strings. `xmlPlugin` sets `weight` on every finding it returns, from the run's weights, so a container in another package can score them.
- `code: 'DEFUSE_LIMIT'` with `limit: 'time'` or `'nesting'`, and `code: 'DEFUSE_IO'` with the original error in `cause`, stop the whole tree. xml-defuse passes either one up when a plugin throws it, and reports no PLUGIN_FAILED. At depth 0 a limit becomes the LIMIT finding and an I/O error is thrown. An I/O error inside a file at depth 1 or more leaves `xmlPlugin` with the I/O code.

## Command line

```
xml-defuse inspect <file> [options]
xml-defuse defuse <in> <out> [options]

--plugin <module>          load plugins from a file or an installed package, repeatable
--config <module>          load a whole options object, repeatable; the other options apply on top
--keep-type <type>         keep contained files of this MIME type or file extension unchanged, repeatable
--defuse-embedded-markup   defuse HTML, XML, SVG and MHT files inside the file, such as an SVG in a data: URL
--strip-metadata
--limit <name>=<value>     fileSize, depth, tokenSize, entityDepth, entityExpansions, entitySize, parts,
                           decodedBytes, nestingDepth, timeMs; sizes accept kb, mb, gb
--json                     print the result as JSON
```

The tool works as pdf-defuse's does. Use `-` for stdin or stdout. `inspect` prints its report to stdout, and so does `defuse` unless the output goes to stdout, and then the report goes to stderr. The text report writes control characters from the file as escapes such as `\u001b`. `defuse` refuses an output that is its input under any name. The tool passes the input file's name to the run, so a file named `.hta` is rejected. Input from stdin has no name.

`fileSize` and `decodedBytes` take sizes, and the other limits take whole numbers. A `--plugin` module exports `plugins`, an array, or `plugin`, one plugin, on the module or its default export. A `--config` module's default export is the options object. Several combine, with their plugin lists joined and their limits merged.

Exit codes are 0 for clean, 1 for stripped or strippable, 2 for rejected and 3 for a usage or I/O error. An unknown option shows in the error without the text after its `=`.

## Memory and time

xml-defuse reads a file in chunks of 64 KiB. The XML and HTML tokenizers hold one tag, comment or declaration at a time, up to `tokenSize`, and pass text on in pieces, so memory does not grow with the length of the text. It does grow with the number of findings, up to 200 of each kind, with the elements that carry an `id` in an SVG drawing, which the `use` check counts, and with the data: URLs, the links whose text is checked and the XSLT calls the first reading hands to the second.

`disarmXmlSource` reads its copy of the upload twice, once to inspect it and once to write the output. It then reads the output twice to check it. MHT parts are decoded once and kept, in memory up to `memoryThreshold` and in temporary files above it.

## What it does not protect against

- Bugs in a browser's image, font or layout code, triggered by ordinary content.
- Phishing made of plain text, images and safe links.
- A link whose visible text names a different site than its target, beyond the host names the link's text and title spell out.
- What a processor does with an XSLT stylesheet beyond the instructions and functions listed above, and what a validating parser does with a DTD or schema it already has.
- Word 2003 and Excel 2003 XML beyond binary data elements. Their other constructs, such as Word fields, are read as plain XML.

## Development

Development needs Node 22.12 or later. mocha 12 requires it, and the CommonJS test build loads chai 6, an ES module, with `require()`, which Node 22 supports only from 22.12. The pre-commit hook needs Node 22.22.1 or later for lint-staged. The published package has no runtime dependencies and runs on Node 18 or later.

```sh
npm install --ignore-scripts
npm run build
npm test
npm run lint
npm run format
```

`npm test` runs the lint, builds the package and the tests, then runs mocha.

`test/fixtures/cases` holds one small crafted file for each problem, and `manifest.json` gives the verdicts inspect and disarm must return for each, with text the output must or must not hold. `node scripts/make-fixtures.js` writes every fixture from scratch, and a second run writes the same bytes. `test/cases.test.ts` checks each entry, and checks that each output inspects clean and defuses again to the same bytes. For a new problem, add a fixture to the script.

`src/entities.ts` holds the HTML Standard's named character references. `node scripts/make-entities.js entities.json` writes it from the standard's `entities.json`.

`npx husky` activates the pre-commit hook, which runs Biome on the staged files and then `npm audit`.

## License

MIT
