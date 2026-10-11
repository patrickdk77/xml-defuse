import { expect } from 'chai';
import { bufferSource } from '../src';
import { TempDir } from '../src/io';
import { leafParts, parseContentType, readMht, rootPart } from '../src/mht';
import { body, disarm, kind, mht, PNG } from './helpers/util';

async function parse(text: string) {
  const temp = new TempDir();
  try {
    const file = await readMht(bufferSource(Buffer.from(text, 'latin1')), { parts: 100, depth: 10, decodedBytes: 1 << 20, memoryThreshold: 1 << 20, temp, check: () => undefined });
    const parts = await Promise.all(
      leafParts(file.parts).map(async p => {
        const b = p.body;
        const data = b ? Buffer.from(await b.source().read(0, b.length)).toString('latin1') : undefined;
        return { index: p.index, type: p.type, location: p.location, id: p.contentId, name: p.name, undecodable: p.undecodable, data };
      }),
    );
    return { type: file.type, hidden: file.hidden, root: rootPart(file)?.index, parts };
  } finally {
    await temp.cleanup();
  }
}

describe('MHT', () => {
  it('reads headers, folded lines and parameters', () => {
    expect(parseContentType('Multipart/Related; boundary="a;b\\"c"; type=text/html; charset=UTF-8')).to.deep.equal({
      type: 'multipart/related',
      params: new Map([
        ['boundary', 'a;b"c'],
        ['type', 'text/html'],
        ['charset', 'UTF-8'],
      ]),
    });
    expect(parseContentType(undefined).type).to.equal('text/plain');
  });

  it('decodes base64 and quoted-printable bodies, keeping the line break before a boundary out of the part', async () => {
    const r = await parse(
      mht([
        'Content-Type: text/html\r\nContent-Transfer-Encoding: quoted-printable\r\nContent-Location: a.htm\r\n\r\n<p class=3D"x">long =\r\nline</p>\r\nnext=20\r\n',
        `Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <img1@x>\r\nContent-Disposition: inline; filename="pic.png"\r\n\r\n${PNG.toString('base64').replace(/(.{20})/g, '$1\r\n')}`,
        'Content-Type: text/plain\r\n\r\nline 1\r\nline 2',
      ]),
    );
    expect(r.parts.map(p => [p.type, p.location, p.id, p.name, p.data])).to.deep.equal([
      ['text/html', 'a.htm', undefined, undefined, '<p class="x">long line</p>\r\nnext \r\n'],
      ['image/png', undefined, 'img1@x', 'pic.png', PNG.toString('latin1')],
      ['text/plain', undefined, undefined, undefined, 'line 1\r\nline 2'],
    ]);
  });

  it('reads nested multipart bodies, takes the root part from the start parameter, and counts what lies outside the parts', async () => {
    const text =
      'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="o"; start="<two@x>"\r\n\r\nThis is a multi-part message in MIME format.\r\n--o\r\nContent-Type: multipart/alternative; boundary="i"\r\n\r\n--i\r\nContent-Type: text/plain\r\n\r\none\r\n--i\r\nContent-Type: text/html\r\nContent-ID: <two@x>\r\n\r\n<p>two</p>\r\n--i--\r\nignored epilogue\r\n--o--\r\ntrailer\r\n';
    const r = await parse(text);
    expect(r).to.deep.equal({
      type: 'multipart/related',
      hidden: 'ignoredepiloguetrailer'.length,
      root: 3,
      parts: [
        { index: 2, type: 'text/plain', location: undefined, id: undefined, name: undefined, undecodable: undefined, data: 'one' },
        { index: 3, type: 'text/html', location: undefined, id: 'two@x', name: undefined, undecodable: undefined, data: '<p>two</p>' },
      ],
    });
  });

  it('marks a part in a transfer encoding it does not decode', async () => {
    const r = await parse(mht(['Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: x-uuencode\r\n\r\nbegin 644 a']));
    expect(r.parts[0].undecodable).to.equal('x-uuencode');
  });

  it('finds the part a reference names: by Content-Location, resolved against the location of the part that refers, or as written, and by Content-ID', async () => {
    const png = PNG.toString('base64');
    const file = mht([
      'Content-Type: text/html\r\nContent-Location: http://site.example/dir/page.htm\r\n\r\n<img src="a.png"><img src="b.png"><img src="cid:C@x"><img src="http://other.example/d.png">',
      `Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-Location: http://site.example/dir/a.png\r\n\r\n${png}`,
      `Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-Location: b.png\r\n\r\n${png}`,
      `Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <c@x>\r\n\r\n${png}`,
    ]);
    const kept = await disarm(file, { filePlugins: [{ kind: 'file', name: 'png', accepts: f => f.sniffedType === 'image/png', process: async () => 'passed' }] });
    const html = Buffer.from(/text\/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([^-]*)/.exec(kept.text)?.[1] ?? '', 'base64').toString('utf8');
    // The parts stay and so do the references to them. The image on another site loads from outside the file.
    expect(html).to.equal('\uFEFF<img src="a.png"><img src="b.png"><img src="cid:C@x"><img>');
    expect(kept.before.findings.map(kind)).to.deep.equal(['EXTERNAL/RESOURCE', 'EMBEDDED/PLUGIN_PASSED', 'EMBEDDED/PLUGIN_PASSED', 'EMBEDDED/PLUGIN_PASSED']);
    // Without a plugin the parts go, and the references with them.
    const dropped = await disarm(file);
    expect(body(dropped)).to.not.include('image/png');
    expect(dropped.before.findings.map(kind)).to.deep.equal(['EXTERNAL/RESOURCE', 'EMBEDDED/NO_PLUGIN', 'EMBEDDED/NO_PLUGIN', 'EMBEDDED/NO_PLUGIN']);
  });
});
