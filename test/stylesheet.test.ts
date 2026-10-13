import { expect } from 'chai';
import { bufferSource, type DefuseFinding, disarmXml, inspectXml, xmlPlugin } from '../src';

const SHEET = '@import url(http://evil.example/x.css);\nbody { background: url(javascript:alert(1)); behavior: url(x.htc); width: expression(alert(1)); }\na { color: red; }\n';
const acted = (findings: DefuseFinding[]) => [...new Set(findings.filter(f => f.action !== 'info').map(f => `${f.category}/${f.detail}`))];
const text = (r: { bytes?: Uint8Array }) => Buffer.from(r.bytes ?? []).toString('utf8');

describe('style sheets', () => {
  it('reads a file the name or the declared type calls CSS with the style rules a style element gets', async () => {
    for (const options of [{ name: 'site.css' }, { declaredType: 'text/css; charset=utf-8' }]) {
      const r = await disarmXml(Buffer.from(SHEET), options);
      expect([r.status, r.before.format, r.before.mimeType, acted(r.before.findings)]).to.deep.equal([
        'defused',
        'css',
        'text/css',
        ['STYLE/REMOTE_URL', 'STYLE/IMPORT', 'SCRIPT/URL', 'STYLE/BINDING', 'STYLE/EXPRESSION'],
      ]);
      expect(text(r)).to.equal('\nbody {    }\na { color: red; }\n');
    }
  });

  it('passes a clean sheet through byte for byte, a UTF-8 byte order mark included', async () => {
    for (const bytes of [Buffer.from('a { color: red; }\n'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a { color: red; }\n')])]) {
      const r = await disarmXml(bytes, { name: 'a.css' });
      expect([r.status, Buffer.from(r.bytes ?? []).equals(bytes)]).to.deep.equal(['clean', true]);
    }
  });

  it('decodes by @charset, writes UTF-8, and makes the @charset name UTF-8', async () => {
    const r = await disarmXml(Buffer.from('@charset "iso-8859-1";\na::after { content: "caf\xe9"; }\n', 'latin1'), { name: 'a.css' });
    expect([r.before.encoding, text(r)]).to.deep.equal(['windows-1252', '@charset "utf-8";\na::after { content: "caf\u00e9"; }\n']);
  });

  it('reads text with no claim as a page, as before, and a sheet that starts with markup as markup', async () => {
    expect((await inspectXml(Buffer.from('a { color: red; }\n'))).format).to.equal('html');
    expect((await inspectXml(Buffer.from('<style>a{}</style>'), { name: 'a.css' })).format).to.equal('html');
  });

  it('lets xmlPlugin take a style sheet a container names', async () => {
    const file = (s: string, name?: string, declaredType?: string) => ({ name, declaredType, size: s.length, location: 'x', depth: 1, source: bufferSource(Buffer.from(s)) });
    expect(await xmlPlugin().accepts(file(SHEET, 'theme.css'))).to.equal(true);
    expect(await xmlPlugin().accepts(file(SHEET, undefined, 'text/css'))).to.equal(true);
    expect(await xmlPlugin().accepts(file(SHEET, 'theme.txt'))).to.equal(false);
  });
});

describe('RELAX NG', () => {
  it('removes the href of an externalRef or include that loads a grammar from elsewhere, and keeps a relative one', async () => {
    const grammar =
      '<grammar xmlns="http://relaxng.org/ns/structure/1.0"><include href="common.rng"/><start><externalRef href="http://evil.example/x.rng"/></start><include href="https://evil.example/y.rng"/></grammar>';
    const r = await disarmXml(Buffer.from(grammar), { name: 'schema.rng' });
    expect(r.before.findings.map(f => `${f.action} ${f.category}/${f.detail}`)).to.deep.equal(['info EXTERNAL/RELATIVE', 'strip XML/SCHEMA_LOCATION', 'strip XML/SCHEMA_LOCATION']);
    expect(text(r)).to.equal('<grammar xmlns="http://relaxng.org/ns/structure/1.0"><include href="common.rng"/><start><externalRef/></start><include/></grammar>\n');
    // An href outside the RELAX NG namespace is not a grammar to load.
    expect((await inspectXml(Buffer.from('<r><include href="http://example.net/x"/></r>'))).findings).to.deep.equal([]);
  });
});

describe('CSS in SVG presentation attributes', () => {
  it('reads a value that spells url( with a CSS escape, as a CSS reader decodes it', async () => {
    for (const value of ['u\\72l(https://evil.example/c)', '\\75rl(https://evil.example/d)', 'U\\52 L(https://evil.example/e)']) {
      const r = await disarmXml(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><rect fill="${value}" stroke="red"/></svg>`), { name: 'logo.svg' });
      expect([value, acted(r.before.findings), text(r)]).to.deep.equal([value, ['STYLE/REMOTE_URL'], '<svg xmlns="http://www.w3.org/2000/svg"><rect stroke="red"/></svg>\n']);
    }
    const kept = await disarmXml(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#g)" stroke="\\72 ed"/></svg>'), { name: 'logo.svg' });
    expect(text(kept)).to.equal('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#g)" stroke="\\72 ed"/></svg>\n');
  });
});
