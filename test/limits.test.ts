import { expect } from 'chai';
import { type ByteSource, bufferSink, bufferSource, disarmXmlSource, inspectXml, inspectXmlSource, type XmlLimits, xmlPlugin } from '../src';
import { HtmlTokenizer } from '../src/html';
import { disarm, kind, mht, page, svg } from './helpers/util';

/** The verdict a limit gives: rejected, no score, and the one kind of finding that stopped the run. */
async function stopped(input: string | Buffer, limits: XmlLimits): Promise<{ status: string; score: number | null; risk: string; stop?: string }> {
  const r = await inspectXml(typeof input === 'string' ? Buffer.from(input) : input, { limits });
  return { status: r.status, score: r.score, risk: r.risk, stop: r.findings.filter(f => f.action === 'reject').map(kind)[0] };
}

const rejectedBy = (stop: string) => ({ status: 'rejected', score: null, risk: 'UNKNOWN', stop });

/** A source that waits `ms` before each read. */
const slow = (bytes: Buffer, ms: number): ByteSource => ({
  size: async () => bytes.length,
  read: async (offset, length) => {
    await new Promise(resolve => setTimeout(resolve, ms));
    return bytes.subarray(offset, offset + length);
  },
});

describe('limits', () => {
  it('rejects a file over the file size limit without reading it', async () => {
    let reads = 0;
    const bytes = Buffer.from(page('<p>x</p>'));
    const counted: ByteSource = {
      size: async () => bytes.length,
      read: async (o, n) => {
        reads++;
        return bytes.subarray(o, o + n);
      },
    };
    const r = await inspectXmlSource(counted, { limits: { fileSize: 10 } });
    expect({ status: r.status, stop: r.findings.map(kind), reads }).to.deep.equal({ status: 'rejected', stop: ['LIMIT/FILE_SIZE'], reads: 0 });
    expect(await stopped(page('<p>x</p>'), { fileSize: 1000 })).to.deep.equal({ status: 'clean', score: 0, risk: 'NONE', stop: undefined });
  });

  it('limits element depth: 256 in XML and 4096 in HTML by default, or the depth given', async () => {
    expect(await stopped(`<r>${'<a>'.repeat(256)}${'</a>'.repeat(256)}</r>`, {})).to.deep.equal(rejectedBy('LIMIT/DEPTH'));
    expect(await stopped(`<r>${'<a>'.repeat(254)}${'</a>'.repeat(254)}</r>`, {})).to.include({ status: 'clean' });
    expect(await stopped(`<div>${'<div>'.repeat(4096)}`, {})).to.deep.equal(rejectedBy('LIMIT/DEPTH'));
    expect(await stopped(`<div>${'<div>'.repeat(4000)}`, {})).to.include({ status: 'clean' });
    expect(await stopped('<p><b><i><u>x', { depth: 3 })).to.deep.equal(rejectedBy('LIMIT/DEPTH'));
    // SVG and MathML inside HTML count too.
    expect(await stopped(`<svg>${'<g>'.repeat(10)}`, { depth: 5 })).to.deep.equal(rejectedBy('LIMIT/DEPTH'));
  });

  it('limits noscript elements inside noscript elements by depth, since their text is read again', async () => {
    expect(await stopped(`${'<noscript>'.repeat(20)}x`, { depth: 10 })).to.deep.equal(rejectedBy('LIMIT/DEPTH'));
    expect(await stopped(`${'<noscript>'.repeat(100000)}x`, {})).to.deep.equal(rejectedBy('LIMIT/DEPTH'));
  });

  it('limits how deep the multipart bodies of an MHT file nest', async () => {
    let m = 'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b0"\r\n\r\n';
    for (let i = 0; i < 10; i++) m += `--b${i}\r\nContent-Type: multipart/related; boundary="b${i + 1}"\r\n\r\n`;
    m += '--b10\r\nContent-Type: text/html\r\n\r\n<p>x</p>\r\n';
    expect(await stopped(m, { depth: 5 })).to.deep.equal(rejectedBy('LIMIT/DEPTH'));
    expect(await stopped(m, { depth: 20 })).to.include({ status: 'clean' });
  });

  it('limits the size of one tag, comment or other token, and of the text of a style or noscript element', async () => {
    const long = 'x'.repeat(200);
    expect(await stopped(page(`<p title="${long}">k</p>`), { tokenSize: 100 })).to.deep.equal(rejectedBy('LIMIT/TOKEN_SIZE'));
    expect(await stopped(`<r a="${long}"/>`, { tokenSize: 100 })).to.deep.equal(rejectedBy('LIMIT/TOKEN_SIZE'));
    expect(await stopped(page(`<!-- ${long} -->`), { tokenSize: 100 })).to.deep.equal(rejectedBy('LIMIT/TOKEN_SIZE'));
    expect(await stopped(page(`<style>p { color: red } ${'/**/'.repeat(50)}</style>`), { tokenSize: 100 })).to.deep.equal(rejectedBy('LIMIT/TOKEN_SIZE'));
    // Text between tags streams, whatever its length.
    expect(await stopped(page(`<p>${long}</p>`), { tokenSize: 100 })).to.include({ status: 'clean' });
  });

  it('limits entity nesting, expansions and expanded text', async () => {
    const nested = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "x"><!ENTITY b "&a;"><!ENTITY c "&b;"><!ENTITY d "&c;">]><r>&d;</r>`;
    expect(await stopped(nested, { entityDepth: 2 })).to.deep.equal(rejectedBy('LIMIT/ENTITY_DEPTH'));
    expect(await stopped(nested, { entityDepth: 4 })).to.include({ status: 'strippable' });
    const many = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "x">]><r>${'&a;'.repeat(20)}</r>`;
    expect(await stopped(many, { entityExpansions: 10 })).to.deep.equal(rejectedBy('LIMIT/ENTITY_EXPANSIONS'));
    const big = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "${'x'.repeat(100)}">]><r>&a;&a;</r>`;
    expect(await stopped(big, { entitySize: 150 })).to.deep.equal(rejectedBy('LIMIT/ENTITY_SIZE'));
    // Attribute defaults count as expansions.
    const defaults = `<?xml version="1.0"?><!DOCTYPE r [<!ATTLIST e a CDATA "v">]><r>${'<e/>'.repeat(20)}</r>`;
    expect(await stopped(defaults, { entityExpansions: 10 })).to.deep.equal(rejectedBy('LIMIT/ENTITY_EXPANSIONS'));
  });

  it('limits the parts of an MHT file and the decoded size of a part or a data: URL', async () => {
    const parts = mht(['Content-Type: text/html\r\n\r\n<p>a</p>', 'Content-Type: text/html\r\n\r\n<p>b</p>', 'Content-Type: text/html\r\n\r\n<p>c</p>']);
    expect(await stopped(parts, { parts: 2 })).to.deep.equal(rejectedBy('LIMIT/PARTS'));
    expect(await stopped(parts, { parts: 3 })).to.include({ status: 'clean' });
    const large = mht([`Content-Type: text/html\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(`<p>${'x'.repeat(100)}</p>`).toString('base64')}`]);
    expect(await stopped(large, { decodedBytes: 50 })).to.deep.equal(rejectedBy('LIMIT/DECODED_SIZE'));
    const dataUrl = page(`<img src="data:text/plain;base64,${Buffer.alloc(100, 0x41).toString('base64')}">`);
    expect(await stopped(dataUrl, { decodedBytes: 50 })).to.deep.equal(rejectedBy('LIMIT/DECODED_SIZE'));
    expect(await stopped(dataUrl, { decodedBytes: 100 })).to.include({ status: 'strippable' });
  });

  it('rejects for time at the upload, and passes the limit up from a file inside it', async () => {
    const bytes = Buffer.from(page(`<p>${'x'.repeat(300000)}</p>`));
    const r = await inspectXmlSource(slow(bytes, 20), { limits: { timeMs: 5 } });
    expect({ status: r.status, stop: r.findings.map(kind) }).to.deep.equal({ status: 'rejected', stop: ['LIMIT/TIME'] });
    const d = await disarmXmlSource(slow(bytes, 20), bufferSink(), { limits: { timeMs: 5 } });
    expect({ status: d.status, stop: d.before.findings.map(kind) }).to.deep.equal({ status: 'rejected', stop: ['LIMIT/TIME'] });
    // A file inside another passes the time limit up, so the whole tree stops.
    const plugin = xmlPlugin();
    const file = { name: 'inner.html', size: bytes.length, location: 'entry', depth: 1, source: slow(bytes, 20) };
    const e = await plugin.process(file, bufferSink(), { depth: 1, deadline: Date.now() + 5 }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).to.include({ code: 'DEFUSE_LIMIT', limit: 'time' });
  });

  it('applies the nesting limit to a file inside another, through the plugin', async () => {
    const inner = svg('<rect/>');
    const upload = page(`<img src="data:image/svg+xml;base64,${Buffer.from(inner).toString('base64')}" alt="k">`);
    const options = { limits: { nestingDepth: 0 } };
    const r = await disarm(upload, { ...options, filePlugins: [xmlPlugin(options)] });
    expect({ status: r.status, score: r.before.score, stop: r.before.findings.filter(f => f.action === 'reject').map(kind) }).to.deep.equal({
      status: 'rejected',
      score: null,
      stop: ['LIMIT/NESTING_DEPTH'],
    });
    const ok = await disarm(upload, { limits: { nestingDepth: 1 }, filePlugins: [xmlPlugin({ limits: { nestingDepth: 1 } })] });
    expect({ status: ok.status, kept: ok.before.findings.map(kind) }).to.deep.equal({ status: 'clean', kept: ['EMBEDDED/PLUGIN_PASSED'] });
  });

  it('rejects a file whose reading fails unexpectedly, and throws any error of the source as an I/O error', async () => {
    const write = HtmlTokenizer.prototype.write;
    try {
      HtmlTokenizer.prototype.write = () => {
        throw new Error('boom');
      };
      const r = await inspectXml(Buffer.from(page('<p>x</p>')));
      expect({ status: r.status, score: r.score, stop: r.findings.map(kind), reason: r.findings[0]?.data?.reason }).to.deep.equal({
        status: 'rejected',
        score: null,
        stop: ['FORMAT/UNREADABLE'],
        reason: 'boom',
      });
    } finally {
      HtmlTokenizer.prototype.write = write;
    }
    const failing = (error: Error): ByteSource => ({
      size: async () => 100,
      read: async () => {
        throw error;
      },
    });
    // A source belongs to the caller, so whatever it throws says nothing about the file.
    const plain = new Error('boom');
    expect(
      await inspectXmlSource(failing(plain)).then(
        () => undefined,
        (err: unknown) => err,
      ),
    ).to.equal(plain);
    const io = Object.assign(new Error('EIO: read failed'), { code: 'EIO' });
    const e = await inspectXmlSource(failing(io)).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).to.equal(io);
    const e2 = await disarmXmlSource(failing(io), bufferSink()).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e2).to.equal(io);
  });

  it('keeps within the limits for a large ordinary page', async () => {
    const rows = Array.from({ length: 20000 }, (_, i) => `<tr><td>${i}</td><td><a href="https://example.com/${i}">row</a></td></tr>`).join('\n');
    const r = await disarm(page(`<table>${rows}</table>`));
    expect(r.status).to.equal('clean');
    expect(r.text).to.include('<td>19999</td>');
    // The per-kind cap counts the rest of the safe links on one finding.
    const safe = r.before.findings.filter(f => kind(f) === 'LINK/SAFE');
    expect(safe.length).to.equal(201);
    expect(safe[200].data?.count).to.equal(19800);
    expect(bufferSource(Buffer.alloc(0))).to.have.property('read');
  });
});
