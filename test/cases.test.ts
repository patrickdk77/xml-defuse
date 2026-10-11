import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from 'chai';
import { disarmXml, inspectXml, type XmlOptions } from '../src';
import { disarmNamed, fixtures, inspectNamed, kindSet } from './helpers/util';

/** One crafted fixture per issue, each written by scripts/make-fixtures.js. */
interface Entry {
  description: string;
  options?: XmlOptions;
  inspect: { status: string; risk?: string; format?: string; encoding?: string; includes?: string[]; excludes?: string[] };
  disarm: { status: string; present?: string[]; absent?: string[] };
}

const casesDir = path.join(fixtures, 'cases');
const manifest: Record<string, Entry> = JSON.parse(fs.readFileSync(path.join(casesDir, 'manifest.json'), 'utf8'));
const read = (name: string) => fs.readFileSync(path.join(casesDir, name));

describe('crafted cases', () => {
  it('lists the same files in the manifest and the folder', () => {
    const onDisk = fs
      .readdirSync(casesDir)
      .filter(name => name !== 'manifest.json')
      .sort();
    expect(onDisk).to.deep.equal(Object.keys(manifest).sort());
  });

  it('describes every fixture', () => {
    for (const [name, entry] of Object.entries(manifest)) expect(entry.description.length, `${name} description`).to.be.greaterThan(0);
  });

  for (const [name, entry] of Object.entries(manifest)) {
    describe(name, () => {
      it('inspects as the manifest expects', async () => {
        // The name goes along, as the command-line tool and the plugin pass it, so a .hta name counts.
        const r = await inspectNamed(read(name), name, entry.options);
        const found = kindSet(r);
        const want = entry.inspect;
        expect({ status: r.status, risk: want.risk && r.risk, format: want.format && r.format, encoding: want.encoding && r.encoding }, name).to.deep.equal({
          status: want.status,
          risk: want.risk,
          format: want.format,
          encoding: want.encoding,
        });
        for (const k of want.includes ?? []) expect(found, `${name} finds ${k}`).to.include(k);
        for (const k of want.excludes ?? []) expect(found, `${name} does not find ${k}`).to.not.include(k);
      });

      it('defuses as the manifest expects, to an output that inspects clean and defuses to the same bytes', async () => {
        const r = await disarmNamed(read(name), name, entry.options);
        expect(r.status, name).to.equal(entry.disarm.status);
        if (r.status === 'rejected') {
          expect(r.bytes, 'no output').to.equal(undefined);
          return;
        }
        const out = Buffer.from(r.bytes ?? []);
        const text = out.toString('utf8');
        for (const s of entry.disarm.present ?? []) expect(text, `${name} output holds ${s}`).to.include(s);
        for (const s of entry.disarm.absent ?? []) expect(text, `${name} output lacks ${s}`).to.not.include(s);
        expect(r.after?.status, 'the check of the output').to.equal('clean');
        // The output is a file of its own: inspected afresh, without the run that made it, it is clean.
        const again = await inspectXml(out);
        expect({ status: again.status, kinds: kindSet(again).filter(k => again.findings.some(f => `${f.category}/${f.detail}` === k && f.action !== 'info')) }).to.deep.equal({
          status: 'clean',
          kinds: [],
        });
        const second = await disarmXml(out);
        expect(second.status).to.equal('clean');
        expect(Buffer.compare(Buffer.from(second.bytes ?? []), out), `${name} defuses again to the same bytes`).to.equal(0);
      });
    });
  }

  it('gives the same verdict through the public API for every fixture whose name changes nothing', async () => {
    for (const [name, entry] of Object.entries(manifest)) {
      if (name.endsWith('.hta')) continue;
      const r = await inspectXml(read(name), entry.options);
      expect(r.status, name).to.equal(entry.inspect.status);
    }
  });
});
