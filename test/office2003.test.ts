import { expect } from 'chai';
import { XmlCategory as C, type ContainedFile, type ContainedFilePlugin, XmlDetail as D, disarmXml, inspectXml } from '../src';
import { PNG } from './helpers/util';

const W = 'http://schemas.microsoft.com/office/word/2003/wordml';
const V = 'http://schemas.microsoft.com/visio/2003/core';

/** A Word 2003 XML document with `inside` in its docSuppData element. */
const wordml = (inside: string) =>
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<?mso-application progid="Word.Document"?>\n<w:wordDocument xmlns:w="${W}"><w:docSuppData>${inside}</w:docSuppData><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:wordDocument>`,
  );
/** A binData element holding `bytes`, in lines of 76 characters as Word writes them. */
const binData = (name: string, bytes: Buffer) => `<w:binData w:name="${name}">\n${bytes.toString('base64').replace(/(.{76})/g, '$1\n')}\n</w:binData>`;
/** The start of an ActiveMime blob, the form Word keeps a VBA project in, as editdata.mso. */
const activeMime = Buffer.concat([Buffer.from('ActiveMime\0\0\x01\0\0\0', 'latin1'), Buffer.alloc(64, 0x41)]);

/** A plugin that takes every file, records it, and passes it or writes `replacement`. */
function plugin(replacement?: Buffer): ContainedFilePlugin & { seen: ContainedFile[] } {
  const seen: ContainedFile[] = [];
  return {
    kind: 'file',
    name: 'test',
    seen,
    accepts: f => {
      seen.push(f);
      return true;
    },
    async process(_file, sink) {
      if (!replacement) return 'passed';
      await sink.write(replacement);
      return 'scrubbed';
    },
  };
}
const kinds = (r: { findings: Array<{ category: string; detail: string }> }) => r.findings.map(f => `${f.category}/${f.detail}`);
const out = (r: { bytes?: Uint8Array }) => Buffer.from(r.bytes ?? []).toString('utf8');

describe('Word and Visio 2003 XML binary data', () => {
  it('reports the VBA project of editdata.mso and drops it, even when a plugin passes the file', async () => {
    const doc = wordml(binData('editdata.mso', activeMime));
    const r = await inspectXml(doc);
    expect(kinds(r).filter(k => k !== 'XML/DOCTYPE')).to.include.members(['SCRIPT/MACRO', 'EMBEDDED/NO_PLUGIN']);
    expect(r.findings.find(f => f.detail === 'MACRO')?.description).to.equal('Binary data in the document holds a VBA project, which Word loads with the document: editdata.mso');
    for (const options of [{}, { filePlugins: [plugin()] }]) {
      const d = await disarmXml(doc, options);
      expect([d.status, out(d).includes('binData'), out(d).includes('Hello')]).to.deep.equal(['defused', false, true]);
      expect((d.after?.findings ?? []).filter(f => f.action !== 'info')).to.deep.equal([]);
    }
    // SCRIPT/MACRO made info leaves the decision to the plugins, which here keep the file.
    const kept = await disarmXml(doc, { filePlugins: [plugin()], actionOverrides: [{ category: C.Script, detail: D.Macro, action: 'info' }] });
    expect(out(kept).includes('editdata.mso')).to.equal(true);
  });

  it('gives a picture to the plugins with the type its name gives, and writes back the copy one makes', async () => {
    const doc = wordml(binData('wordml://03000001.png', PNG));
    const seen = plugin();
    const passed = await disarmXml(doc, { filePlugins: [seen] });
    expect([seen.seen[0]?.name, seen.seen[0]?.declaredType, seen.seen[0]?.sniffedType, seen.seen[0]?.size]).to.deep.equal(['wordml://03000001.png', 'image/png', 'image/png', PNG.length]);
    expect(out(passed).includes(PNG.toString('base64').slice(0, 76))).to.equal(true);
    const replacement = Buffer.from('a smaller picture');
    const scrubbed = await disarmXml(doc, { filePlugins: [plugin(replacement)] });
    expect(out(scrubbed)).to.include(`>${replacement.toString('base64')}</w:binData>`);
    // With no plugin, the picture goes, as a data: URL's file does.
    const alone = await disarmXml(doc);
    expect([kinds(alone.before).includes('EMBEDDED/NO_PLUGIN'), out(alone).includes('binData')]).to.deep.equal([true, false]);
  });

  it("gives a Visio ForeignData element's data to the plugins, typed by its compression", async () => {
    const vdx = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n<VisioDocument xmlns="${V}"><Pages><Page><Shapes><Shape><ForeignData ForeignType="Bitmap" CompressionType="PNG">${PNG.toString('base64')}</ForeignData></Shape></Shapes></Page></Pages></VisioDocument>`,
    );
    const seen = plugin();
    const d = await disarmXml(vdx, { filePlugins: [seen] });
    expect([d.status, seen.seen[0]?.declaredType, seen.seen[0]?.sniffedType]).to.deep.equal(['clean', 'image/png', 'image/png']);
    expect(out(await disarmXml(vdx)).includes('ForeignData')).to.equal(false);
  });

  it('keeps an empty binData element without asking the plugins', async () => {
    const seen = plugin();
    const d = await disarmXml(wordml('<w:binData w:name="empty.bin"></w:binData>'), { filePlugins: [seen] });
    expect([d.status, seen.seen.length]).to.deep.equal(['clean', 0]);
  });
});
