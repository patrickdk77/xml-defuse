import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import { type ByteSource, bufferSink, bufferSource, XmlCategory as C, XmlDetail as D, disarmXml, disarmXmlSource, fileSink, fileSource, inspectXml, writableSink } from '../src';
import { HtmlWriter, XmlWriter } from '../src/writer';
import { body, disarm, kind, mht, page, svg } from './helpers/util';

/** The output of a clean or defused file, as text without the byte order mark. */
async function out(input: string | Buffer, options = {}): Promise<string> {
  const r = await disarm(input, options);
  if (r.status === 'rejected') throw new Error(`rejected: ${r.before.findings.map(kind).join(', ')}`);
  return body(r);
}

describe('the rewrite', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xml-defuse-rewrite-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('HTML', () => {
    it('writes UTF-8 after a byte order mark, and says so in the meta elements', async () => {
      const latin = Buffer.concat([
        Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"></head><body>caf', 'latin1'),
        Buffer.from([0xe9]),
        Buffer.from('</body></html>'),
      ]);
      const r = await disarm(latin);
      expect(r.before.encoding).to.equal('windows-1252');
      expect(r.text.startsWith('\uFEFF<html>')).to.equal(true);
      expect(body(r)).to.equal('<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body>caf\u00e9</body></html>');
      expect(await out('<meta charset="shift_jis"><p>x</p>')).to.equal('<meta charset="utf-8"><p>x</p>');
    });

    it('escapes text and attribute values so no text becomes markup, and keeps a carriage return a reference made', async () => {
      expect(await out('<p title="a&quot;b<c>&amp;">1 &lt; 2 &gt; 0 &amp; x&#13;y</p>')).to.equal('<p title="a&quot;b&lt;c&gt;&amp;">1 &lt; 2 &gt; 0 &amp; x&#13;y</p>');
      // Unquoted and single-quoted values come out double-quoted.
      expect(await out("<p class=a id='b'>x</p>")).to.equal('<p class="a" id="b">x</p>');
    });

    it('writes raw text so that neither an HTML nor an XML reader finds markup in it', async () => {
      expect(await out('<style>p::before { content: "<b>" } /* </p> */</style>')).to.equal('<style>p::before { content: "\\3c b>" } /* \\3c /p> */</style>');
      expect(await out('<p><xmp><b>x</b> 1 < 2</xmp>')).to.equal('<p><xmp>&lt;b>x&lt;/b> 1 < 2</xmp>');
      expect(await out('<p><textarea><b>x</b></textarea>')).to.equal('<p><textarea>&lt;b&gt;x&lt;/b&gt;</textarea>');
      expect(await out('<script>if (a < b) x()</script>', { actionOverrides: [{ category: C.Script, detail: D.Element, action: 'info' }] })).to.equal('<script>if (a < b) x()</script>');
    });

    it('writes the end tags the file wrote, and no others, except for SVG and MathML, which XML readers need closed', async () => {
      expect(await out('<ul><li>a<li>b</ul><p>c<div>d</div></p>')).to.equal('<ul><li>a<li>b</ul><p>c<div>d</div></p>');
      expect(await out('<p><svg><g><rect></svg>x')).to.equal('<p><svg><g><rect></rect></g></svg>x');
      expect(await out('<svg><circle/><path d="M0"/></svg>')).to.equal('<svg><circle/><path d="M0"/></svg>');
    });

    it('writes comments and the comments HTML makes of other markup, and drops NUL characters', async () => {
      expect(await out('<!-- a --><?pi x?><!x>\0<p>k</p>')).to.equal('<!-- a --><!--?pi x?--><!--x--><p>k</p>');
    });

    it('writes a document type declaration with only the identifiers a rule kept', async () => {
      expect(await out('<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><p>x</p>')).to.equal(
        '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><p>x</p>',
      );
      expect(await out('<!DOCTYPE html SYSTEM "http://example.net/x.dtd"><p>x</p>')).to.equal('<!DOCTYPE html><p>x</p>');
    });

    it('starts a page that looked like XML with the HTML5 declaration, so its output is read as HTML again', async () => {
      const r = await disarm('<?xml version="1.0"?>\n<!DOCTYPE r SYSTEM "r.dtd">\n<r><p>open</r>');
      expect({ status: r.status, format: r.before.format, kinds: r.before.findings.map(kind) }).to.deep.equal({ status: 'defused', format: 'html', kinds: ['XML/MALFORMED', 'XML/EXTERNAL_DTD'] });
      expect(body(r)).to.equal('<!DOCTYPE html><!--?xml version="1.0"?-->\n\n<r><p>open</r>');
      expect((await inspectXml(Buffer.from(r.text))).format).to.equal('html');
    });

    it('reads a noscript element twice, as scripting on and off read it, and writes what passes both', async () => {
      expect(await out('<noscript><img src="#" onerror="x()"><b>k</b></noscript><p>after</p>')).to.equal('<noscript><img src="#"><b>k</b></noscript><p>after</p>');
      const r = await disarm('<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>');
      expect(r.before.findings.map(kind)).to.include('SCRIPT/EVENT_HANDLER');
      expect(body(r)).to.not.include('onerror');
    });
  });

  describe('XML', () => {
    it('writes UTF-8, with a declaration when the file had one or another encoding', async () => {
      expect(await out('<r>x</r>')).to.equal('<r>x</r>\n');
      expect(await out('<?xml version="1.0" standalone="yes"?><r>x</r>')).to.equal('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<r>x</r>\n');
      const latin = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><r>', 'latin1'), Buffer.from([0xe9]), Buffer.from('</r>')]);
      expect(await out(latin)).to.equal('<?xml version="1.0" encoding="UTF-8"?>\n<r>\u00e9</r>\n');
    });

    it('declares again the namespaces an element needs when the element that declared them goes', async () => {
      const input =
        '<r><x:a xmlns:x="urn:x" xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="b"/><x:b/></x:a><s:script xmlns:s="http://www.w3.org/2000/svg"><x:c xmlns:x="urn:x"/></s:script></r>';
      expect(await out(input)).to.equal('<r><x:a xmlns:x="urn:x" xmlns:xi="http://www.w3.org/2001/XInclude"><x:b/></x:a></r>\n');
      // A dropped parent's binding is declared on the kept child.
      expect(await out('<r xmlns:p="urn:p"><p:a><p:b/></p:a></r>')).to.equal('<r xmlns:p="urn:p"><p:a><p:b/></p:a></r>\n');
      expect(await out('<form xmlns="http://www.w3.org/1999/xhtml"><svg:g xmlns:svg="http://www.w3.org/2000/svg"/></form>')).to.equal('<svg:g xmlns:svg="http://www.w3.org/2000/svg"/>\n');
    });

    it('closes an empty XHTML element that is not void, so an HTML reader does not leave it open', async () => {
      expect(await out('<html xmlns="http://www.w3.org/1999/xhtml"><body><div/><br/><p/></body></html>')).to.equal(
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><div></div><br/><p></p></body></html>\n',
      );
    });

    it('expands entity references, writes CDATA as text, and keeps white space in attribute values as references', async () => {
      const input = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY e "<b>bold</b>">]><r a="x&#10;y&#9;z&#13;"><![CDATA[1 < 2]]>&e;</r>';
      expect(await out(input)).to.equal('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE r>\n<r a="x&#10;y&#9;z&#13;">1 &lt; 2<b>bold</b></r>\n');
    });

    it('keeps comments and processing instructions that both readers end in the same place', async () => {
      expect(await out(svg('<!-- note --><?app keep?><rect/>'))).to.include('<!-- note --><?app keep?><rect/>');
    });
  });

  describe('MHT', () => {
    it('writes each kept part in base64 under new boundaries, with the headers it had and a UTF-8 charset for markup', async () => {
      const r = await disarm(
        mht([
          'Content-Type: text/html; charset="windows-1252"\r\nContent-Transfer-Encoding: quoted-printable\r\nContent-Location: file:///C:/a.htm\r\n\r\n<p onclick=3D"x()">caf=E9</p>',
          'Content-Type: text/css\r\nContent-Location: file:///C:/a.css\r\n\r\np { color: red; width: expression(1) }',
        ]),
      );
      expect(r.status).to.equal('defused');
      const text = r.text;
      expect(text).to.match(/^MIME-Version: 1.0\r\nContent-Type: multipart\/related; boundary="----=_xml-defuse_1_boundary"; type="text\/html"\r\n\r\n/);
      const parts = text.split('------=_xml-defuse_1_boundary').slice(1, -1);
      const decoded = parts.map(p => {
        const [head, b] = p.split('\r\n\r\n');
        return [head.trim(), Buffer.from(b.replace(/\s+/g, ''), 'base64').toString('utf8')];
      });
      expect(decoded).to.deep.equal([
        ['Content-Location: file:///C:/a.htm\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64', '\uFEFF<p>caf\u00e9</p>'],
        ['Content-Location: file:///C:/a.css\r\nContent-Type: text/css; charset=utf-8\r\nContent-Transfer-Encoding: base64', 'p { color: red; }'],
      ]);
    });

    it('writes a page saved as one MIME body as one base64 body', async () => {
      const r = await disarm('MIME-Version: 1.0\r\nContent-Type: text/html\r\n\r\n<p onclick="x()">k</p>\r\n');
      expect({ status: r.status, format: r.before.format }).to.deep.equal({ status: 'defused', format: 'mht' });
      expect(r.text).to.equal(`MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('\uFEFF<p>k</p>').toString('base64')}\r\n`);
    });
  });

  describe('the check of the output', () => {
    it('reads the output in the other syntax too, and rejects an output only that reading finds unsafe', async () => {
      // An internal subset kept by override holds a comment. An HTML reader ends the declaration at its first ">",
      // and reads the comment's text as markup.
      const input = '<?xml version="1.0"?><!DOCTYPE r [<!--><img src=x onerror=alert(1)>-->]><r>k</r>';
      const r = await disarm(input, { actionOverrides: [{ category: C.Xml, detail: D.InternalSubset, action: 'info' }] });
      const failed = r.before.findings.find(f => f.detail === D.VerificationFailed);
      expect({ status: r.status, reasons: failed?.data?.reasons }).to.deep.equal({ status: 'rejected', reasons: 'SCRIPT/EVENT_HANDLER when read as HTML' });
      expect((await disarm(input)).status).to.equal('defused');
    });

    it('rejects an output that fails its own check, and never writes it to the sink', async () => {
      const start = HtmlWriter.prototype.start;
      try {
        // Stands in for a writer bug: every element gets a handler.
        HtmlWriter.prototype.start = function (this: HtmlWriter, el, attrs) {
          start.call(this, el, [...attrs, { qname: 'onclick', local: 'onclick', ns: '', value: 'x()' }]);
        };
        const file = path.join(dir, 'checked.html');
        const r = await disarmXmlSource(bufferSource(Buffer.from(page('<p>k</p>'))), fileSink(file));
        const failed = r.before.findings.find(f => f.detail === D.VerificationFailed);
        expect({ status: r.status, action: failed?.action, reasons: failed?.data?.reasons, written: fs.existsSync(file) }).to.deep.equal({
          status: 'rejected',
          action: 'reject',
          // The page is well-formed XML too, so the XML reading finds the handler as well.
          reasons: 'SCRIPT/EVENT_HANDLER, SCRIPT/EVENT_HANDLER when read as XML',
          written: false,
        });
      } finally {
        HtmlWriter.prototype.start = start;
      }
      expect(XmlWriter.name).to.equal('XmlWriter');
    });
  });

  describe('sources and sinks', () => {
    it('gives identical output from a buffer source and a file source, and to a file sink and a Node writable', async () => {
      const input = Buffer.from(page(`<p onclick="x()">${'text '.repeat(50000)}</p>`));
      const file = path.join(dir, 'in.html');
      fs.writeFileSync(file, input);
      const a = bufferSink();
      await disarmXmlSource(bufferSource(input), a);
      const outFile = path.join(dir, 'out.html');
      await disarmXmlSource(fileSource(file), fileSink(outFile));
      const pt = new PassThrough({ highWaterMark: 16 });
      const chunks: Buffer[] = [];
      pt.on('data', c => chunks.push(c));
      await disarmXmlSource(bufferSource(input), writableSink(pt));
      expect(pt.writableFinished).to.equal(true);
      expect([Buffer.compare(Buffer.from(a.result()), fs.readFileSync(outFile)), Buffer.compare(Buffer.from(a.result()), Buffer.concat(chunks))]).to.deep.equal([0, 0]);
    });

    it('reads a source that changes between reads once, so both passes see the same bytes', async () => {
      let reads = 0;
      const first = Buffer.from(page('<p>first</p>'));
      const second = Buffer.from(page('<p>second<script>x()</script>'));
      const changing: ByteSource = { size: async () => first.length, read: async (o, n) => (reads++ === 0 ? first : second).subarray(o, o + n) };
      const sink = bufferSink();
      const r = await disarmXmlSource(changing, sink);
      expect({ status: r.status, out: Buffer.from(sink.result()).toString('utf8') }).to.deep.equal({ status: 'clean', out: `\uFEFF${page('<p>first</p>')}` });
    });

    it('goes through temporary files past the memory threshold and gives the same output', async () => {
      const input = Buffer.from(page(`<p>${'x'.repeat(100000)}</p><img src="https://example.net/a.png">`));
      const small = await disarmXml(input, { memoryThreshold: 1024, tempDir: dir });
      const large = await disarmXml(input);
      expect(Buffer.compare(Buffer.from(small.bytes ?? []), Buffer.from(large.bytes ?? []))).to.equal(0);
      expect(fs.readdirSync(dir).filter(n => n.startsWith('xml-defuse-'))).to.deep.equal([]);
    });

    it('closes the caller source when the run ends', async () => {
      let closed = 0;
      const input = Buffer.from(page('<p>k</p>'));
      const src: ByteSource = { size: async () => input.length, read: async (o, n) => input.subarray(o, o + n), close: async () => void closed++ };
      await disarmXmlSource(src, bufferSink());
      await inspectXml(input);
      expect(closed).to.equal(1);
    });
  });
});
