import { expect } from 'chai';
import { allFindingSpecs, disarmXml, inspectXml, type XmlActionOverride, XmlCategory, XmlDetail, type XmlOptions } from '../src';
import { body, disarm, disarmNamed, has, inspectNamed, kind, mht, PNG, page, svg, xsl } from './helpers/util';

/** One input that makes a kind of finding, and what its default action does to the output. */
interface Example {
  input: string | Buffer;
  options?: XmlOptions;
  /** Text the output loses under the default action. */
  gone?: string[];
  /** Text the output keeps under the default action. */
  kept?: string[];
  /**
   * Text the output holds when the kinds in `override`, this kind alone unless it says otherwise, are set to info:
   * the rule decides for what it names and nothing else. Left out for a kind whose content goes whatever the action,
   * or that removes nothing of its own.
   */
  overrideKeeps?: string[];
  override?: string[];
  /** The disarm status, when another finding or a metadata strip makes it differ from what this kind's action gives. */
  status?: 'clean' | 'defused';
}

const DATA_PNG = `data:image/png;base64,${PNG.toString('base64')}`;
const XSLT_MS = ' xmlns:msxsl="urn:schemas-microsoft-com:xslt" xmlns:u="urn:u"';
const XSI = ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

const EXAMPLES: Record<string, Example> = {
  'FORMAT/UNRECOGNIZED': { input: Buffer.from([0, 1, 2, 0, 0x41]) },
  'FORMAT/HTA': { input: page('<HTA:APPLICATION ID="app"/>') },
  'FORMAT/OFFICE': { input: '<?xml version="1.0"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:mimetype="application/vnd.oasis.opendocument.text"/>' },
  'FORMAT/UTF7': { input: '<html><head><meta charset="utf-7"></head><body>+ADw-b+AD4-</body></html>', gone: ['utf-7'], kept: ['charset="utf-8"', '+ADw-b+AD4-'] },
  'FORMAT/AMBIGUOUS_COMMENT': { input: svg('<!--><b>x</b>--><rect/>'), gone: ['<b>x</b>'], kept: ['<rect/>'] },
  'FORMAT/AMBIGUOUS_INSTRUCTION': { input: svg('<?x a>b?><rect/>'), gone: ['<?x a'], kept: ['<rect/>'] },
  'FORMAT/CONDITIONAL_COMMENT': { input: page('<!--[if IE]><b>ie</b><![endif]--><p>k</p>'), gone: ['[if IE]'], kept: ['<p>k</p>'], overrideKeeps: ['<!--[if IE]><b>ie</b><![endif]-->'] },
  'XML/DOCTYPE': {
    input: '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"/>',
    kept: ['<!DOCTYPE svg PUBLIC'],
  },
  'XML/INTERNAL_SUBSET': { input: '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY e "v">]><r>&e;</r>', gone: ['<!ENTITY'], kept: ['<r>v</r>'], overrideKeeps: ['<!ENTITY e "v">', '<r>v</r>'] },
  'XML/EXTERNAL_DTD': {
    input: '<?xml version="1.0"?><!DOCTYPE r SYSTEM "http://example.net/r.dtd"><r/>',
    gone: ['example.net'],
    kept: ['<!DOCTYPE r>'],
    overrideKeeps: ['SYSTEM "http://example.net/r.dtd"'],
  },
  'XML/EXTERNAL_ENTITY': {
    input: '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>a&x;b</r>',
    gone: ['&x;', 'passwd'],
    kept: ['<r>ab</r>'],
    // The reference needs its declaration, so the subset stays too.
    override: ['XML/EXTERNAL_ENTITY', 'XML/INTERNAL_SUBSET'],
    overrideKeeps: ['<r>a&x;b</r>', 'SYSTEM "file:///etc/passwd"'],
  },
  'XML/XINCLUDE': {
    input: '<r xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="a.xml"/><p>k</p></r>',
    gone: ['xi:include'],
    kept: ['<p>k</p>'],
    overrideKeeps: ['<xi:include href="a.xml"/>'],
  },
  'XML/MALFORMED': { input: '<?xml version="1.0"?><r><p>text</r>', kept: ['<p>text'] },
  'XML/ENCODING': { input: '<?xml version="1.0" encoding="x-not-one"?><r>text</r>', kept: ['<r>text</r>'] },
  'XML/SCHEMA_LOCATION': {
    input: `<r${XSI} xsi:noNamespaceSchemaLocation="http://example.net/r.xsd">k</r>`,
    gone: ['example.net'],
    kept: ['<r'],
    overrideKeeps: ['xsi:noNamespaceSchemaLocation="http://example.net/r.xsd"'],
  },
  'SCRIPT/ELEMENT': { input: page('<script>alert(1)</script><p>k</p>'), gone: ['alert(1)'], kept: ['<p>k</p>'], overrideKeeps: ['<script>alert(1)</script>'] },
  'SCRIPT/EVENT_HANDLER': { input: page('<p onclick="alert(1)">k</p>'), gone: ['onclick'], kept: ['<p>k</p>'], overrideKeeps: ['<p onclick="alert(1)">k</p>'] },
  'SCRIPT/URL': { input: page('<a href="javascript:alert(1)">k</a>'), gone: ['javascript'], kept: ['<a>k</a>'], overrideKeeps: ['<a href="javascript:alert(1)">k</a>'] },
  'SCRIPT/ANIMATION': {
    input: svg('<a href="#x"><set attributeName="href" to="#y"/><text>t</text></a>'),
    gone: ['<set'],
    kept: ['<text>t</text>'],
    overrideKeeps: ['<set attributeName="href" to="#y"/>'],
  },
  'STYLE/EXPRESSION': { input: page('<p style="width: expression(alert(1)); color: red">k</p>'), gone: ['expression'], kept: ['color: red'], overrideKeeps: ['width: expression(alert(1))'] },
  'STYLE/BINDING': { input: page('<p style="behavior: url(#default#x); color: red">k</p>'), gone: ['behavior'], kept: ['color: red'], overrideKeeps: ['behavior: url(#default#x)'] },
  'STYLE/IMPORT': { input: page('<style>@import "#none"; p { color: red }</style>'), gone: ['@import'], kept: ['color: red'], overrideKeeps: ['@import "#none";'] },
  'STYLE/REMOTE_URL': {
    input: page('<p style="background: url(https://example.net/b.png); color: red">k</p>'),
    gone: ['example.net'],
    kept: ['color: red'],
    overrideKeeps: ['url(https://example.net/b.png)'],
  },
  'STYLE/ESCAPED': { input: page('<p style="col\\6fr: red">k</p>'), kept: ['col\\6fr: red'] },
  'STYLE/MARKUP_IN_STYLE': { input: svg('<style>rect { fill: red }<g>x</g></style><rect/>'), gone: ['<g>x</g>'], kept: ['fill: red'], overrideKeeps: ['<g>x</g>'] },
  'EXTERNAL/RESOURCE': { input: page('<img src="https://example.net/a.png" alt="k">'), gone: ['example.net'], kept: ['alt="k"'], overrideKeeps: ['src="https://example.net/a.png"'] },
  'EXTERNAL/RELATIVE': { input: page('<img src="images/a.png" alt="k">'), kept: ['src="images/a.png"'] },
  'EXTERNAL/PATH_TRICK': { input: page('<img src="%2e%2e/x.png" alt="k">'), gone: ['x.png'], kept: ['alt="k"'], overrideKeeps: ['src="%2e%2e/x.png"'] },
  'EXTERNAL/STYLESHEET': {
    input: page('<link rel="stylesheet" href="https://example.net/s.css"><p>k</p>'),
    gone: ['example.net'],
    kept: ['<p>k</p>'],
    overrideKeeps: ['href="https://example.net/s.css"'],
  },
  'EXTERNAL/PREFETCH': { input: page('<link rel="dns-prefetch" href="//example.net"><p>k</p>'), gone: ['example.net'], kept: ['<p>k</p>'], overrideKeeps: ['href="//example.net"'] },
  'EXTERNAL/IMPORT': { input: page('<link rel="import" href="https://example.net/i.html"><p>k</p>'), gone: ['example.net'], kept: ['<p>k</p>'], overrideKeeps: ['href="https://example.net/i.html"'] },
  'EXTERNAL/LOCAL_FILE': { input: page('<img src="file:///C:/x.png" alt="k">'), gone: ['file:'], kept: ['alt="k"'], overrideKeeps: ['src="file:///C:/x.png"'] },
  'EXTERNAL/NETWORK_PATH': { input: page('<img src="\\\\host\\share\\x.png" alt="k">'), gone: ['host'], kept: ['alt="k"'], overrideKeeps: ['src="\\\\host\\share\\x.png"'] },
  'EXTERNAL/OTHER_SCHEME': { input: page('<img src="ms-its:x.chm::/a.png" alt="k">'), gone: ['ms-its'], kept: ['alt="k"'], overrideKeeps: ['src="ms-its:x.chm::/a.png"'] },
  'LINK/SAFE': { input: page('<a href="https://example.com/">example.com</a>'), kept: ['href="https://example.com/"'] },
  'LINK/FILE_URL': { input: page('<a href="file:///C:/x.exe">k</a>'), gone: ['file:'], kept: ['<a>k</a>'], overrideKeeps: ['href="file:///C:/x.exe"'] },
  'LINK/NETWORK_PATH': { input: page('<a href="\\\\host\\share">k</a>'), gone: ['host'], kept: ['<a>k</a>'], overrideKeeps: ['href="\\\\host\\share"'] },
  'LINK/DATA_URL': { input: page('<a href="data:text/html,hi">k</a>'), gone: ['data:'], kept: ['<a>k</a>'], overrideKeeps: ['href="data:text/html,hi"'] },
  'LINK/OTHER_SCHEME': { input: page('<a href="ms-msdt:/id x">k</a>'), gone: ['ms-msdt'], kept: ['<a>k</a>'], overrideKeeps: ['href="ms-msdt:/id x"'] },
  'LINK/CREDENTIALS': { input: page('<a href="https://user@example.net/">k</a>'), gone: ['example.net'], kept: ['<a>k</a>'], overrideKeeps: ['href="https://user@example.net/"'] },
  'LINK/IP_HOST': { input: page('<a href="http://192.0.2.1/">k</a>'), gone: ['192.0.2.1'], kept: ['<a>k</a>'], overrideKeeps: ['href="http://192.0.2.1/"'] },
  'LINK/LOOKALIKE_HOST': { input: page('<a href="https://xn--bcher-kva.example/">k</a>'), gone: ['xn--'], kept: ['<a>k</a>'], overrideKeeps: ['href="https://xn--bcher-kva.example/"'] },
  'LINK/ENCODED_HOST': { input: page('<a href="https://%65xample.net/">k</a>'), gone: ['%65'], kept: ['<a>k</a>'], overrideKeeps: ['href="https://%65xample.net/"'] },
  'LINK/TEXT_MISMATCH': {
    input: page('<a href="https://example.net/">https://bank.example.com</a>'),
    gone: ['example.net'],
    kept: ['https://bank.example.com</a>'],
    overrideKeeps: ['href="https://example.net/"'],
  },
  'LINK/RELATIVE': { input: page('<a href="other.html">k</a>'), kept: ['href="other.html"'] },
  'LINK/PATH_TRICK': { input: page('<a href="a/../../etc/passwd">k</a>'), gone: ['etc/passwd'], kept: ['<a>k</a>'], overrideKeeps: ['href="a/../../etc/passwd"'] },
  'FORM/SUBMIT': {
    input: page('<form action="https://example.net/p"><input name="q"></form>'),
    gone: ['<form', 'example.net'],
    kept: ['<input name="q">'],
    overrideKeeps: ['<form action="https://example.net/p">'],
  },
  'FORM/PASSWORD': { input: page('<input type="password" name="p">'), kept: ['type="password"'] },
  'NAVIGATION/REFRESH': {
    input: page('<meta http-equiv="refresh" content="0; https://example.net/"><p>k</p>'),
    gone: ['refresh', 'example.net'],
    kept: ['<p>k</p>'],
    overrideKeeps: ['http-equiv="refresh"'],
  },
  'NAVIGATION/RELATIVE_REFRESH': { input: page('<meta http-equiv="refresh" content="30; url=next.html"><p>k</p>'), kept: ['http-equiv="refresh"', 'url=next.html'] },
  'NAVIGATION/BASE': { input: page('<base href="https://example.net/"><p>k</p>'), gone: ['<base'], kept: ['<p>k</p>'], overrideKeeps: ['<base href="https://example.net/">'] },
  'NAVIGATION/RELATIVE_BASE': { input: page('<base href="docs/"><a href="a.html">k</a>'), kept: ['<base href="docs/">', 'href="a.html"'] },
  'NAVIGATION/PATH_TRICK': {
    input: page('<meta http-equiv="refresh" content="0; url=a/../../x.html"><p>k</p>'),
    gone: ['refresh', 'x.html'],
    kept: ['<p>k</p>'],
    overrideKeeps: ['url=a/../../x.html'],
  },
  'NAVIGATION/SET_COOKIE': { input: page('<meta http-equiv="set-cookie" content="a=b"><p>k</p>'), gone: ['set-cookie'], kept: ['<p>k</p>'], overrideKeeps: ['http-equiv="set-cookie"'] },
  'EMBEDDED/IFRAME': {
    input: page('<iframe src="https://example.net/"></iframe><p>k</p>'),
    gone: ['<iframe'],
    kept: ['<p>k</p>'],
    // The frame stays, and its source goes by the resource rule.
    overrideKeeps: ['<iframe></iframe>'],
  },
  'EMBEDDED/FRAME': { input: '<html><frameset><frame name="f"></frameset></html>', gone: ['<frame'], overrideKeeps: ['<frameset><frame name="f"></frameset>'] },
  'EMBEDDED/OBJECT': { input: page('<object data="#x"><p>fallback</p></object>'), gone: ['<object'], kept: ['<p>fallback</p>'], overrideKeeps: ['<object data="#x"><p>fallback</p></object>'] },
  'EMBEDDED/EMBED': { input: page('<embed type="x/y"><p>k</p>'), gone: ['<embed'], kept: ['<p>k</p>'], overrideKeeps: ['<embed type="x/y">'] },
  'EMBEDDED/APPLET': { input: page('<applet name="a"><p>fallback</p></applet>'), gone: ['<applet'], kept: ['<p>fallback</p>'], overrideKeeps: ['<applet name="a"><p>fallback</p></applet>'] },
  'EMBEDDED/NO_PLUGIN': { input: page(`<img src="${DATA_PNG}" alt="k">`), gone: ['data:image'], kept: ['alt="k"'], overrideKeeps: [DATA_PNG] },
  // With no plugin, the file goes by NO_PLUGIN.
  'EMBEDDED/TYPE_MISMATCH': { input: page(`<img src="data:image/gif;base64,${PNG.toString('base64')}" alt="k">`), kept: ['alt="k"'], status: 'defused' },
  'SVG/FOREIGN_OBJECT': {
    input: svg('<foreignObject><p xmlns="http://www.w3.org/1999/xhtml">k</p></foreignObject><rect/>'),
    gone: ['foreignObject'],
    kept: ['<rect/>'],
    overrideKeeps: ['<foreignObject>'],
  },
  'SVG/USE_EXTERNAL': { input: svg('<use href="https://example.net/s.svg#a"/><rect/>'), gone: ['example.net'], kept: ['<rect/>'], overrideKeeps: ['<use href="https://example.net/s.svg#a"/>'] },
  'SVG/USE_AMPLIFICATION': {
    input: svg(
      `<defs><g id="g0"><rect/><rect/><rect/><rect/><rect/></g>${Array.from({ length: 9 }, (_, i) => `<g id="g${i + 1}">${`<use href="#g${i}"/>`.repeat(10)}</g>`).join('')}</defs><use href="#g9"/>`,
    ),
    gone: ['<use'],
    kept: ['<rect/>'],
    overrideKeeps: ['<use href="#g9"/>'],
  },
  'XSLT/SCRIPT': {
    input: xsl('<msxsl:script language="JScript" implements-prefix="u">function f() {}</msxsl:script><xsl:template match="/">k</xsl:template>', XSLT_MS),
    gone: ['msxsl:script'],
    kept: ['<xsl:template match="/">k</xsl:template>'],
    overrideKeeps: ['function f() {}'],
  },
  'XSLT/EXTENSION_FUNCTION': {
    input: xsl('<xsl:template match="/"><xsl:value-of select="php:function(\'f\')"/><b>k</b></xsl:template>', ' xmlns:php="http://php.net/xsl"'),
    gone: ['php:function'],
    kept: ['<b>k</b>'],
    overrideKeeps: ['php:function'],
  },
  'XSLT/EXTENSION_ELEMENT': {
    input: xsl(
      '<xsl:template match="/"><redirect:write file="/tmp/x">y</redirect:write><b>k</b></xsl:template>',
      ' xmlns:redirect="http://xml.apache.org/xalan/redirect" extension-element-prefixes="redirect"',
    ),
    gone: ['redirect:write'],
    kept: ['<b>k</b>'],
    overrideKeeps: ['<redirect:write file="/tmp/x">y</redirect:write>'],
  },
  'XSLT/DOCUMENT': {
    input: xsl('<xsl:template match="/"><xsl:copy-of select="document(\'x.xml\')"/><b>k</b></xsl:template>'),
    gone: ['x.xml'],
    kept: ['<b>k</b>'],
    overrideKeeps: ["document('x.xml')"],
  },
  'XSLT/INCLUDE': { input: xsl('<xsl:include href="b.xsl"/><xsl:template match="/">k</xsl:template>'), gone: ['b.xsl'], kept: ['>k</xsl:template>'], overrideKeeps: ['<xsl:include href="b.xsl"/>'] },
  'XSLT/RESULT_DOCUMENT': {
    input: xsl('<xsl:template match="/"><xsl:result-document href="o.txt">x</xsl:result-document><b>k</b></xsl:template>', '', '2.0'),
    gone: ['result-document'],
    kept: ['<b>k</b>'],
    overrideKeeps: ['<xsl:result-document href="o.txt">'],
  },
  'XSLT/UNESCAPED_OUTPUT': {
    input: xsl('<xsl:template match="/"><xsl:value-of select="." disable-output-escaping="yes"/></xsl:template>'),
    gone: ['disable-output-escaping'],
    kept: ['<xsl:value-of select="."/>'],
    overrideKeeps: ['disable-output-escaping="yes"'],
  },
  'XSLT/EVALUATE': {
    input: xsl('<xsl:template match="/"><xsl:evaluate xpath="string(.)"/><b>k</b></xsl:template>', '', '3.0'),
    gone: ['xsl:evaluate'],
    kept: ['<b>k</b>'],
    overrideKeeps: ['<xsl:evaluate xpath="string(.)"/>'],
  },
  'SERVER/SSI': { input: page('<!--#exec cmd="ls" --><p>k</p>'), gone: ['#exec'], kept: ['<p>k</p>'], overrideKeeps: ['<!--#exec cmd="ls" -->'] },
  'SERVER/ESI': {
    input: page('<esi:include src="http://example.net/"/><p>k</p>'),
    gone: ['esi:include', 'example.net'],
    kept: ['<p>k</p>'],
    overrideKeeps: ['<esi:include src="http://example.net/">'],
  },
  'SERVER/CODE': { input: page('<?php echo 1; ?><p>k</p>'), gone: ['php'], kept: ['<p>k</p>'], overrideKeeps: ['<!--?php echo 1; ?-->'] },
  'MHT/MALFORMED': { input: 'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b1"\r\n\r\nnothing\r\n' },
  'MHT/HIDDEN_DATA': {
    input: `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b1"\r\n\r\nhidden text\r\n--b1\r\nContent-Type: text/html\r\n\r\n<p>k</p>\r\n--b1--\r\n`,
    gone: ['hidden text'],
  },
  'METADATA/STRIPPED': {
    input: page('<meta name="author" content="Someone"><!-- note --><p>k</p>'),
    options: { stripMetadata: true },
    gone: ['Someone', 'note'],
    kept: ['<p>k</p>'],
    status: 'defused',
  },
  'PROCESSING/MEMORY_FALLBACK': {
    input: mht([`Content-Type: text/html\r\n\r\n<p>${'k'.repeat(2000)}</p>`]),
    options: { memoryThreshold: 1024 },
    kept: ['Content-Type: text/html; charset=utf-8'],
  },
  'PROCESSING/CONTENT_REMOVED': { input: page('<img src="#" alt="a""onerror=alert(1)"><p>k</p>'), gone: ['onerror'], kept: ['<p>k</p>'] },
};

/** Kinds made only by a limit, a plugin, a failed check or a failed read, which other test files cover by name. */
const ELSEWHERE: Record<string, string> = {
  'FORMAT/UNREADABLE': 'limits.test.ts',
  'LIMIT/FILE_SIZE': 'limits.test.ts',
  'LIMIT/DEPTH': 'limits.test.ts',
  'LIMIT/TOKEN_SIZE': 'limits.test.ts',
  'LIMIT/ENTITY_DEPTH': 'limits.test.ts',
  'LIMIT/ENTITY_EXPANSIONS': 'limits.test.ts',
  'LIMIT/ENTITY_SIZE': 'limits.test.ts',
  'LIMIT/PARTS': 'limits.test.ts',
  'LIMIT/DECODED_SIZE': 'limits.test.ts',
  'LIMIT/NESTING_DEPTH': 'limits.test.ts',
  'LIMIT/TIME': 'limits.test.ts',
  'EMBEDDED/PLUGIN_PASSED': 'plugins.test.ts',
  'EMBEDDED/PLUGIN_SCRUBBED': 'plugins.test.ts',
  'EMBEDDED/PLUGIN_FAILED': 'plugins.test.ts',
  'EMBEDDED/PLUGIN_REMOVED': 'plugins.test.ts',
  'PROCESSING/VERIFICATION_FAILED': 'rewrite.test.ts',
  'SCRIPT/MACRO': 'office2003.test.ts',
};

const specs = new Map(allFindingSpecs().map(s => [`${s.category}/${s.detail}`, s]));

/** The override that sets these kinds to info. */
const toInfo = (kinds: string[]): XmlActionOverride[] =>
  kinds.map(k => {
    const [category, detail] = k.split('/') as [XmlCategory, XmlDetail];
    return { category, detail, action: 'info' };
  });

describe('rules', () => {
  it('has an example or a named test for every kind of finding, and nothing else', () => {
    const covered = [...Object.keys(EXAMPLES), ...Object.keys(ELSEWHERE)].sort();
    expect(covered).to.deep.equal([...specs.keys()].sort());
    expect(Object.keys(EXAMPLES).filter(k => k in ELSEWHERE)).to.deep.equal([]);
  });

  it('describes every kind, and gives every kind that strips or rejects on its own a weight or a reason', () => {
    for (const [k, s] of specs) {
      expect(s.description.length, k).to.be.greaterThan(10);
      expect(['reject', 'strip', 'info'], k).to.include(s.action);
    }
    expect(Object.values(XmlCategory).sort()).to.deep.equal([...new Set([...specs.values()].map(s => s.category))].sort());
    expect(Object.values(XmlDetail).every(d => [...specs.values()].some(s => s.detail === d))).to.equal(true);
  });

  for (const [k, ex] of Object.entries(EXAMPLES)) {
    describe(k, () => {
      const spec = specs.get(k);
      it(`is reported with its default action, ${spec?.action}`, async () => {
        const r = await inspectNamed(ex.input, 'upload', ex.options);
        const found = r.findings.filter(f => kind(f) === k);
        expect(found.length, `${k} in ${r.findings.map(kind).join(', ')}`).to.be.greaterThan(0);
        expect(found.map(f => f.action)).to.include(spec?.action);
        expect(found.every(f => f.description.length > 0)).to.equal(true);
      });

      if (spec?.action === 'reject') {
        it('rejects the file and writes nothing', async () => {
          const r = await disarmNamed(ex.input, 'upload', ex.options);
          expect({ status: r.status, bytes: r.bytes }).to.deep.equal({ status: 'rejected', bytes: undefined });
        });
        return;
      }

      it('rewrites the file as its action says', async () => {
        const r = await disarm(ex.input, ex.options);
        expect(r.status).to.equal(ex.status ?? (spec?.action === 'strip' ? 'defused' : 'clean'));
        for (const s of ex.gone ?? []) expect(body(r), `${k} output lacks ${s}`).to.not.include(s);
        for (const s of ex.kept ?? []) expect(body(r), `${k} output keeps ${s}`).to.include(s);
        if (spec?.action === 'strip') expect(r.removed.map(kind)).to.include(k);
      });

      const keeps = ex.overrideKeeps;
      if (keeps)
        it('keeps what it names, and only that, when overridden to info', async () => {
          const plain = await disarm(ex.input, ex.options);
          const r = await disarm(ex.input, { ...ex.options, actionOverrides: toInfo(ex.override ?? [k]) });
          expect(r.status, JSON.stringify(r.before.findings.filter(f => f.action !== 'info').map(f => [kind(f), f.data]))).to.not.equal('rejected');
          for (const s of keeps) expect(body(r), `${k} overridden keeps ${s}`).to.include(s);
          expect(has(r.before, k)).to.equal(true);
          // Every other finding kept its own action.
          const others = (x: typeof r) =>
            x.before.findings
              .filter(f => !(ex.override ?? [k]).includes(kind(f)))
              .map(f => `${kind(f)}:${f.action}`)
              .sort();
          expect(others(r)).to.deep.equal(others(plain));
        });
    });
  }
});

describe('the name option', () => {
  it('makes a file named .hta FORMAT/HTA, as the command-line tool and xmlPlugin do with the names they get', async () => {
    const bytes = Buffer.from(page('<p>k</p>'));
    const named = await inspectXml(bytes, { name: 'tool.HTA' });
    expect(named.findings.map(kind)).to.include('FORMAT/HTA');
    expect((await disarmXml(bytes, { name: 'tool.hta' })).status).to.equal('rejected');
    expect((await inspectXml(bytes, { name: 'page.html' })).findings.map(kind)).to.not.include('FORMAT/HTA');
  });
});
