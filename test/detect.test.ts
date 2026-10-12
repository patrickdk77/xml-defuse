import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from 'chai';
import { type ByteSource, bufferSource, detectXml, detectXmlSource, inspectXml, xmlPlugin } from '../src';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(json|md)$/.test(e.name) ? [] : [path.join(dir, e.name)]));

/** Fixtures where detection and the full read name different things, and why. */
const DIFFERENT: Record<string, string | undefined> = {
  // office-defuse's, which xml-defuse refuses.
  'cases/office-flat.fodt': undefined,
  // XML in EBCDIC, which xml-defuse claims and refuses, since it does not decode EBCDIC.
  'cases/xml-ebcdic.xml': 'application/xml',
  // Text with no markup at the start: the inspection reads it as HTML, as a browser shows text, but it is not markup.
  'cases/text-only.html': undefined,
  // The namespace comes from an entity in the internal subset, which only the full read expands.
  'cases/svg-internal-entities.svg': 'application/xml',
  // The full read stops at an entity limit.
  'cases/xml-entity-expansion.xml': 'application/xml',
  'cases/xml-entity-size.xml': 'application/xml',
  // XML that does not parse, or that the XML reading cannot decode, is read again as HTML.
  'cases/xml-malformed.xml': 'application/xml',
  'cases/xml-unknown-encoding.xml': 'application/xml',
};

describe('detectXml', () => {
  it('names the format the inspection reads, for every fixture but the listed few', async function () {
    this.timeout(120_000);
    const seen = new Set<string>();
    for (const file of walk(FIXTURES)) {
      const key = path.relative(FIXTURES, file).split(path.sep).join('/');
      const bytes = fs.readFileSync(file);
      const d = await detectXml(bytes);
      if (key in DIFFERENT) {
        seen.add(key);
        expect(d?.mimeType, key).to.equal(DIFFERENT[key]);
        continue;
      }
      const r = await inspectXml(bytes);
      expect(d?.mimeType, key).to.equal(r.mimeType || undefined);
    }
    expect([...seen].sort()).to.deep.equal(Object.keys(DIFFERENT).sort());
  });

  it("names SVG, XSLT and XHTML by the root element's namespace, as the inspection does", async () => {
    const samples: Array<[string, string]> = [
      ['<svg xmlns="http://www.w3.org/2000/svg"/>', 'svg'],
      ['<?xml version="1.0"?><x:stylesheet xmlns:x="http://www.w3.org/1999/XSL/Transform" version="1.0"/>', 'xsl'],
      ['<?xml version="1.0"?><out xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xsl:version="1.0"/>', 'xsl'],
      ['<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><body/></html>', 'xhtml'],
      ['<?xml version="1.0"?><svg/>', 'xml'],
      ['<p>a page</p>', 'html'],
      ['MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b"\r\n\r\n--b--\r\n', 'mht'],
    ];
    for (const [text, extension] of samples) {
      const d = await detectXml(Buffer.from(text));
      expect(d?.extension, text).to.equal(extension);
      expect(d?.mimeType, text).to.equal((await inspectXml(Buffer.from(text))).mimeType);
    }
    expect(await detectXml(Buffer.from('just text'))).to.equal(undefined);
    expect(await detectXml(Buffer.from('%PDF-1.7\n<html>'))).to.equal(undefined);
  });

  it('goes by content alone, leaves the source open, and lets xmlPlugin take what it finds', async () => {
    expect(await detectXml(Buffer.from('<p>x</p>'), { name: 'a.pdf', declaredType: 'application/pdf' })).to.deep.equal({ mimeType: 'text/html', extension: 'html', offset: 0 });
    let closed = 0;
    const inner = bufferSource(Buffer.from('<p>x</p>'));
    const source: ByteSource = { size: () => inner.size(), read: (o, n) => inner.read(o, n), close: async () => void closed++ };
    expect((await detectXmlSource(source))?.extension).to.equal('html');
    expect(closed).to.equal(0);
    const file = (s: string, name?: string) => ({ name, size: s.length, location: 'x', depth: 1, source: bufferSource(Buffer.from(s)) });
    expect(await xmlPlugin().accepts(file('<p>x</p>', 'a.txt'))).to.equal(true);
    expect(await xmlPlugin().accepts(file('plain words', 'a.html'))).to.equal(false);
    expect(await xmlPlugin().accepts(file(fs.readFileSync(path.join(FIXTURES, 'cases', 'office-flat.fodt'), 'latin1')))).to.equal(false);
  });
});
