# Changelog

## 0.2.0 - 2026-10-17

- EMBEDDED/PLUGIN_PASSED and PLUGIN_SCRUBBED weigh 0, in the upload's score and the output's. The output's score counted them at 20 and 10. A file a plugin kept now scores what the plugin found in it.
- EMBEDDED/PLUGIN_FAILED weighs 30, what EMBEDDED/NO_PLUGIN weighs, since no plugin answered for the file. It weighed 0.

## 0.1.3 - 2026-10-13

- xml-defuse now reads an SVG presentation attribute such as `fill` or `stroke` as CSS when its value spells `url(` with a CSS escape, as `u\72l(` does, so a remote `url()` in it is STYLE/REMOTE_URL. Before, it read only a value with `url(` written out.

## 0.1.2 - 2026-10-12

- A file whose name or declared type says CSS, with no markup at the start, is read as a style sheet with the rules a `style` element gets, and `detectXml` claims it as `text/css`. The new `declaredType` option carries the upload's type, and `xmlPlugin` passes each file's. The rewrite is UTF-8, and an `@charset` rule that named another encoding names UTF-8 in it.
- The `href` of a RELAX NG `externalRef` or `include` that loads a grammar from elsewhere is XML/SCHEMA_LOCATION, as an XML Schema `schemaLocation` is. A relative one stays.

## 0.1.1 - 2026-10-11

- `detectXml` and `detectXmlSource` tell a router whether xml-defuse reads a file and in which format. `xmlPlugin` takes what they find, and decides between XML and HTML on the first 64 KiB, as the inspection does, where it looked at 4 KiB.
- XML in EBCDIC is refused with the new FORMAT/EBCDIC. It was read as HTML, which an XML reader that decodes EBCDIC does not do.

## 0.1.0 - 2026-10-11

The first release.

### Formats

- HTML, XHTML, SVG, XML, XSLT and MHT, picked by content. A page saved as one MIME body counts as MHT.
- XML that is not well-formed is read as HTML, as a browser reads a page. Text with no markup is read as HTML too.
- Binary content, HTML Applications and Office documents saved as XML are rejected. A file named `.hta` is rejected when the `name` option, the command-line tool or `xmlPlugin` gives its name.

### Reading

- XML goes through office-defuse's tokenizer, with its limits on depth, token size and entity expansion. External DTDs and entities are never fetched.
- HTML goes through a tokenizer that follows every tokenizer state of the WHATWG HTML Standard, and through the parts of tree construction that decide namespaces and raw text. The README lists where it differs from a browser.
- HTML encodings follow the WHATWG sniffing algorithm. Node's `TextDecoder` decodes them, and xml-defuse adds the replacement encoding, and x-user-defined where Node lacks it.

### Rules

- Scripts, event handlers, script URLs and SVG animations that set links or handlers.
- CSS `expression()`, `behavior`, `-moz-binding`, ActiveX filters, `@import` and URLs that load from outside the file.
- DTDs, external entities, XInclude, and schema locations that are not relative.
- XSLT script, extension functions and elements, `document()` and the other functions that read files, includes, `xsl:result-document`, `xsl:evaluate`, unescaped output, and elements and attributes an instruction makes in the result. Calls count in attribute value templates and in XSLT 3.0 text value templates too.
- Frames, objects, embeds, applets, forms, and meta refreshes, `base` addresses, resources and links that load or lead outside the file.
- Whatever sits at a relative address stays, at `info`. Links, images, style sheets, `@import`s, SVG `use` files, `ping`, `manifest`, CSS `xml-stylesheet` instructions and schema locations are LINK/RELATIVE or EXTERNAL/RELATIVE. A meta refresh that reloads the page or moves to a relative address is NAVIGATION/RELATIVE_REFRESH, and a relative `base` address is NAVIGATION/RELATIVE_BASE.
- A meta refresh is read as browsers read it, with or without `url=`, and stays only when every address a reader could take from it is relative.
- LINK/PATH_TRICK, EXTERNAL/PATH_TRICK and NAVIGATION/PATH_TRICK take a relative path written to read as another path: control characters, backslashes, encoded dots, slashes or NULs, segments of only dots and spaces, and a path that climbs above where it started after naming a folder.
- `xml-stylesheet` and `xml-model` instructions are read by their pseudo-attributes, so a decoy such as `title="href='a.css'"` cannot hide the real address. An instruction whose pseudo-attributes do not parse is removed.
- SVG `foreignObject`, `use` elements that copy from another file, and `use` elements that copy each other into millions of elements.
- Server-side includes, Edge Side Includes and server code, conditional comments, UTF-7, and comments and processing instructions that HTML and XML readers end in different places.
- Data outside the parts of an MHT file.
- Each rule makes its own strip or allow decision, and `actionOverrides` change one without the others.

### Rewrite and output check

- Every file that is not rejected is written again. HTML is written in UTF-8 after a byte order mark, XML in UTF-8, and MHT with each kept part in base64.
- The output is checked in its own syntax and in the other one before anything reaches the sink. Defusing an output again gives the same bytes.

### Plugins and the family

- `filePlugins` get the files inside a file: data: URLs that load, `iframe` `srcdoc` pages, MHT parts that are not markup or CSS, and the base64 files in Word 2003 XML `w:binData` and Visio 2003 XML `ForeignData` elements. `xmlPlugin` and `passThrough` are bundled.
- A `w:binData` element holding an ActiveMime blob, the VBA project Word keeps as `editdata.mso`, is SCRIPT/MACRO. The element goes whatever the plugins decide.
- `xmlPlugin(options)`, the plugin context, `DefuseFinding`, `weight` and the `DEFUSE_LIMIT` and `DEFUSE_IO` codes follow pdf-defuse.

### Command line

- `xml-defuse inspect` and `xml-defuse defuse`, with the options and exit codes of pdf-defuse's tool.
