import { expect } from 'chai';
import {
  bufferSink,
  bufferSource,
  XmlCategory as C,
  type ContainedFile,
  type ContainedFilePlugin,
  XmlDetail as D,
  type DefuseFinding,
  disarmXml,
  inspectXml,
  passThrough,
  scoreFindings,
  xmlPlugin,
} from '../src';
import { findingSpec } from '../src/findings';
import { sniffType } from '../src/sniff';
import { body, disarm, has, kind, mht, PNG, page, svg } from './helpers/util';

const exif: DefuseFinding = { category: 'IMAGE', detail: 'EXIF', description: 'The image carries EXIF metadata', action: 'strip', weight: 30 };
const comment: DefuseFinding = { category: 'IMAGE', detail: 'COMMENT', description: 'The image carries a comment', action: 'reject' };

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const pngUrl = `data:image/png;base64,${b64(PNG)}`;
const svgUrl = (s: string) => `data:image/svg+xml;base64,${b64(s)}`;

/** The image plugin of another package: it keeps PNG files, or writes `replacement`, and reports `findings` about each. */
const imagePlugin = (findings: DefuseFinding[] = [exif], replacement?: Buffer): ContainedFilePlugin => ({
  kind: 'file',
  name: 'image',
  accepts: f => f.sniffedType === 'image/png',
  async process(_file, sink) {
    if (!replacement) return { result: 'passed', findings };
    await sink.write(replacement);
    return { result: 'scrubbed', findings };
  },
});

/** A made-up container format: "BOX1", then lines of a name and that entry's bytes in base64. */
const box = (...entries: Array<[string, Buffer]>) => Buffer.from(`BOX1\n${entries.map(([name, data]) => `${name}\n${data.toString('base64')}\n`).join('')}`);

/** The container plugin of another package of the family. Each entry goes back through the router with a context of its own. */
const boxPlugin = (router: ContainedFilePlugin): ContainedFilePlugin => ({
  kind: 'file',
  name: 'box',
  accepts: f => f.name?.endsWith('.box') === true,
  async process(file, sink, context) {
    const kept: Array<[string, Buffer]> = [];
    const findings: DefuseFinding[] = [];
    const lines = Buffer.from(await file.source.read(0, file.size))
      .toString()
      .split('\n');
    for (let i = 1; i + 1 < lines.length; i += 2) {
      const name = lines[i];
      const data = Buffer.from(lines[i + 1], 'base64');
      const entry: ContainedFile = { name, sniffedType: sniffType(data), size: data.length, location: `entry ${name}`, depth: context.depth + 1, source: bufferSource(data) };
      if (!(await router.accepts(entry))) continue;
      const out = bufferSink();
      const r = await router.process(entry, out, { depth: entry.depth, deadline: context.deadline });
      const result = typeof r === 'string' ? { result: r } : r;
      for (const f of result.findings ?? []) findings.push({ ...f, attachment: f.attachment ? `${name} > ${f.attachment}` : name });
      if (result.result !== 'removed') kept.push([name, out.size() > 0 ? Buffer.from(out.result()) : data]);
    }
    await sink.write(box(...kept));
    return { result: 'scrubbed', findings };
  },
});

/** The router a master package builds: the first plugin that accepts a file gets it, with the context it came with. */
const routerOver = (plugins: ContainedFilePlugin[], seen: string[] = []): ContainedFilePlugin => ({
  kind: 'file',
  name: 'router',
  async accepts(f) {
    for (const p of plugins) if (await p.accepts(f)) return true;
    return false;
  },
  async process(file, sink, context) {
    for (const p of plugins) {
      if (!(await p.accepts(file))) continue;
      seen.push(`${p.name} ${file.name ?? '-'} ${file.depth}/${context.depth}`);
      return p.process(file, sink, context);
    }
    return 'removed';
  },
});

/** A plugin that throws `error` from accepts() or from process(). */
const throwing = (from: 'accepts' | 'process', error: Error): ContainedFilePlugin => ({
  kind: 'file',
  name: 'thrower',
  accepts: () => {
    if (from === 'accepts') throw error;
    return true;
  },
  process: async () => {
    throw error;
  },
});

const asFile = (data: string | Buffer, name?: string, depth = 1): ContainedFile => {
  const bytes = Buffer.from(data);
  return { name, sniffedType: sniffType(bytes), size: bytes.length, location: `entry ${name ?? '-'}`, depth, source: bufferSource(bytes) };
};

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('plugins', () => {
  describe('xmlPlugin', () => {
    it('accepts a file by its content, whatever its name or declared type says', async () => {
      const p = xmlPlugin();
      const accepts = async (data: string | Buffer, name?: string) => p.accepts({ ...asFile(data, name), declaredType: 'application/octet-stream' });
      expect({
        htmlAsPng: await accepts('<!DOCTYPE html><p>x</p>', 'image.png'),
        svg: await accepts(svg('<rect/>'), 'logo.svg'),
        xml: await accepts('<?xml version="1.0"?><r/>'),
        mhtml: await accepts(mht(['Content-Type: text/html\r\n\r\n<p>x</p>'])),
        pngAsSvg: await accepts(PNG, 'logo.svg'),
        text: await accepts('just text', 'notes.html'),
        flatOdf: await accepts('<?xml version="1.0"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.3"/>', 'a.fodt'),
        flatOpc: await accepts('<?xml version="1.0"?><pkg:package xmlns:pkg="http://schemas.microsoft.com/office/2006/xmlPackage"/>', 'a.xml'),
      }).to.deep.equal({ htmlAsPng: true, svg: true, xml: true, mhtml: true, pngAsSvg: false, text: false, flatOdf: false, flatOpc: false });
    });

    it('defuses the file, and returns its findings and its output findings with their weights', async () => {
      const sink = bufferSink();
      const r = await xmlPlugin().process(asFile(page('<script>x()</script><p onclick="y()">k</p>'), 'page.html'), sink, { depth: 1 });
      if (typeof r === 'string') throw new Error('expected a result object');
      expect({ result: r.result, findings: r.findings?.map(f => [kind(f), f.weight]), output: r.outputFindings?.map(kind) }).to.deep.equal({
        result: 'scrubbed',
        findings: [
          ['SCRIPT/ELEMENT', 70],
          ['SCRIPT/EVENT_HANDLER', 60],
        ],
        output: [],
      });
      expect(Buffer.from(sink.result()).toString('utf8')).to.include('<p>k</p>');
    });

    it('passes a clean file and removes a rejected one, such as any page named .hta', async () => {
      const clean = await xmlPlugin().process(asFile(page('<p>k</p>'), 'page.html'), bufferSink(), { depth: 1 });
      const hta = await xmlPlugin().process(asFile(page('<p>k</p>'), 'tool.hta'), bufferSink(), { depth: 1 });
      expect([typeof clean === 'string' ? clean : clean.result, typeof hta === 'string' ? hta : [hta.result, hta.findings?.map(kind)]]).to.deep.equal(['passed', ['removed', ['FORMAT/HTA']]]);
    });

    it("takes the run's options when built without its own, and its own when given", async () => {
      // The upload's run strips links of other schemes by default; the override makes them info in the nested run too.
      const inner = page('<a href="ftp://example.net/f">k</a>');
      const upload = page(`<img src="${svgUrl(inner)}" alt="i">`);
      const options = { actionOverrides: [{ category: C.Link, detail: D.OtherScheme, action: 'info' as const }] };
      const inherited = await disarmXml(Buffer.from(upload), { ...options, filePlugins: [xmlPlugin()] });
      const own = await disarmXml(Buffer.from(upload), { ...options, filePlugins: [xmlPlugin({})] });
      expect([inherited.before.findings.map(kind), own.before.findings.map(kind)]).to.deep.equal([
        ['EMBEDDED/TYPE_MISMATCH', 'LINK/OTHER_SCHEME', 'EMBEDDED/PLUGIN_PASSED'],
        ['EMBEDDED/TYPE_MISMATCH', 'LINK/OTHER_SCHEME', 'EMBEDDED/PLUGIN_SCRUBBED'],
      ]);
    });
  });

  describe('whole files inside the file', () => {
    it('hands a data: URL that holds a file to the plugins, and keeps, rewrites or drops it as they decide', async () => {
      const upload = page(`<img src="${pngUrl}" alt="k">`);
      const passed = await disarm(upload, { filePlugins: [imagePlugin([])] });
      const scrubbed = await disarm(upload, { filePlugins: [imagePlugin([], Buffer.from('new bytes'))] });
      const removed = await disarm(upload, { filePlugins: [{ ...imagePlugin(), process: async () => 'removed' }] });
      const failed = await disarm(upload, { filePlugins: [throwing('process', new Error('broken'))] });
      const none = await disarm(upload);
      const summary = (r: Awaited<ReturnType<typeof disarm>>) => ({ status: r.status, kinds: r.before.findings.map(kind), src: /<img[^>]*>/.exec(body(r))?.[0] });
      expect([summary(passed), summary(scrubbed), summary(removed), summary(failed), summary(none)]).to.deep.equal([
        { status: 'clean', kinds: ['EMBEDDED/PLUGIN_PASSED'], src: `<img src="${pngUrl}" alt="k">` },
        { status: 'defused', kinds: ['EMBEDDED/PLUGIN_SCRUBBED'], src: `<img src="data:image/png;base64,${b64('new bytes')}" alt="k">` },
        { status: 'defused', kinds: ['EMBEDDED/PLUGIN_REMOVED'], src: '<img alt="k">' },
        { status: 'defused', kinds: ['EMBEDDED/PLUGIN_FAILED'], src: '<img alt="k">' },
        { status: 'defused', kinds: ['EMBEDDED/NO_PLUGIN'], src: '<img alt="k">' },
      ]);
      // The check of the output knows the kept and the rewritten file by their bytes.
      expect([passed.after?.findings.map(kind), scrubbed.after?.findings.map(kind)]).to.deep.equal([['EMBEDDED/PLUGIN_PASSED'], ['EMBEDDED/PLUGIN_SCRUBBED']]);
    });

    it('hands the page in an iframe srcdoc attribute to the plugins as a file', async () => {
      const upload = page('<iframe srcdoc="&lt;script&gt;x()&lt;/script&gt;&lt;b onclick=y()&gt;k&lt;/b&gt;"></iframe>');
      const options = { actionOverrides: [{ category: C.Embedded, detail: D.Iframe, action: 'info' as const }] };
      const none = await disarm(upload, options);
      const defused = await disarm(upload, { ...options, filePlugins: [xmlPlugin()] });
      expect([none.before.findings.map(kind), /<iframe[^>]*>/.exec(body(none))?.[0]]).to.deep.equal([['EMBEDDED/IFRAME', 'EMBEDDED/NO_PLUGIN'], '<iframe>']);
      expect([defused.before.findings.map(kind), /<iframe[^>]*>/.exec(body(defused))?.[0]]).to.deep.equal([
        ['EMBEDDED/IFRAME', 'SCRIPT/ELEMENT', 'SCRIPT/EVENT_HANDLER', 'EMBEDDED/PLUGIN_SCRUBBED'],
        '<iframe srcdoc="\uFEFF&lt;b&gt;k&lt;/b&gt;">',
      ]);
    });

    it('hands data: URLs in style sheets and SVG to the plugins, and rewrites them in place', async () => {
      const upload = page(`<style>p { background: url(${pngUrl}) }</style><svg><image href="${pngUrl}"/></svg>`);
      const r = await disarm(upload, { filePlugins: [imagePlugin([], Buffer.from('x'))] });
      expect({ status: r.status, kinds: r.before.findings.map(kind) }).to.deep.equal({ status: 'defused', kinds: ['EMBEDDED/PLUGIN_SCRUBBED', 'EMBEDDED/PLUGIN_SCRUBBED'] });
      expect(body(r))
        .to.include(`background: url("data:image/png;base64,${b64('x')}")`)
        .and.include(`<image href="data:image/png;base64,${b64('x')}"/>`);
    });

    it('hands the parts of an MHT file that are not markup or CSS to the plugins, with their names and declared types', async () => {
      const seen: Array<[string | undefined, string | undefined, string | undefined, number]> = [];
      const spy: ContainedFilePlugin = {
        kind: 'file',
        name: 'spy',
        accepts: f => {
          seen.push([f.name, f.declaredType, f.sniffedType, f.depth]);
          return f.sniffedType === 'image/png';
        },
        process: async () => 'passed',
      };
      const file = mht([
        'Content-Type: text/html\r\nContent-Location: file:///C:/p.htm\r\n\r\n<p><img src="p_files/a.png"><img src="p_files/b.bin"></p>',
        `Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-Location: file:///C:/p_files/a.png\r\n\r\n${b64(PNG)}`,
        'Content-Type: application/octet-stream\r\nContent-Location: file:///C:/p_files/b.bin\r\n\r\nMZ binary',
      ]);
      const r = await disarm(file, { filePlugins: [spy] });
      expect(seen).to.deep.equal([
        ['a.png', 'image/png', 'image/png', 1],
        ['b.bin', 'application/octet-stream', 'application/x-msdownload', 1],
      ]);
      // A reference to a kept part stays, one to a dropped part goes with it.
      expect({ status: r.status, kinds: r.before.findings.map(kind) }).to.deep.equal({ status: 'defused', kinds: ['EMBEDDED/PLUGIN_PASSED', 'EMBEDDED/NO_PLUGIN'] });
      expect(body(r)).to.include('Content-Location: file:///C:/p_files/a.png').and.not.include('p_files/b.bin');
    });

    it('reports the types of a file that disagree, and lets an override drop it', async () => {
      const upload = page(`<img src="data:image/gif;base64,${b64(PNG)}" alt="k">`);
      const r = await inspectXml(Buffer.from(upload), { filePlugins: [imagePlugin([])] });
      const f = r.findings.find(x => x.detail === D.TypeMismatch);
      expect({ action: f?.action, data: f?.data }).to.deep.equal({ action: 'info', data: { name: '', declared: 'image/gif', sniffed: 'image/png', nameType: '' } });
      const dropped = await disarm(upload, { filePlugins: [imagePlugin([])], actionOverrides: [{ category: C.Embedded, detail: D.TypeMismatch, action: 'strip' }] });
      expect(dropped.before.findings.map(kind)).to.deep.equal(['EMBEDDED/TYPE_MISMATCH']);
      expect(body(dropped)).to.not.include('data:image');
    });

    it('keeps a plugin that never accepts out of the way, and goes on to the next', async () => {
      const r = await disarm(page(`<img src="${pngUrl}">`), { filePlugins: [throwing('accepts', new Error('no')), passThrough(['image/png'])] });
      expect(r.before.findings.map(f => [kind(f), f.data?.plugin])).to.deep.equal([['EMBEDDED/PLUGIN_PASSED', 'passThrough(image/png)']]);
    });
  });

  describe('passThrough', () => {
    it('keeps files by MIME type or by extension, without looking at the content', async () => {
      const p = passThrough(['image/png', '.CSV', 'txt']);
      const accepts = (f: Partial<ContainedFile>) => p.accepts({ size: 0, location: '', depth: 1, source: bufferSource(Buffer.alloc(0)), ...f });
      expect([
        await accepts({ sniffedType: 'image/png' }),
        await accepts({ declaredType: 'IMAGE/PNG; x=y' }),
        await accepts({ name: 'a.csv' }),
        await accepts({ name: 'notes.TXT' }),
        await accepts({ name: 'a.png' }),
        await accepts({ name: 'a.gif' }),
      ]).to.deep.equal([true, true, true, true, true, false]);
      expect(await p.process(asFile('x'), bufferSink(), { depth: 1 })).to.equal('passed');
    });
  });

  describe('the defuse family', () => {
    it('gives each plugin the depth of the file itself, through a router inside the file', async () => {
      const seen: string[] = [];
      const plugins: ContainedFilePlugin[] = [];
      const router = routerOver(plugins, seen);
      plugins.push(xmlPlugin({ filePlugins: [router] }), imagePlugin([]));
      const inner = svg(`<image href="${pngUrl}"/>`);
      const r = await disarm(page(`<img src="${svgUrl(inner)}"><img src="${pngUrl}">`), { filePlugins: [router] });
      expect({ status: r.status, seen }).to.deep.equal({ status: 'clean', seen: ['xml - 1/1', 'image - 2/2', 'image - 1/1'] });
    });

    it('counts depth through a container from another package around markup', async () => {
      const seen: string[] = [];
      const plugins: ContainedFilePlugin[] = [];
      const router = routerOver(plugins, seen);
      plugins.push(xmlPlugin({ filePlugins: [router] }), imagePlugin(), boxPlugin(router));
      const upload = box(['page.html', Buffer.from(page(`<img src="${pngUrl}"><script>x()</script>`))], ['logo.png', PNG]);
      const r = await router.process({ name: 'upload.box', size: upload.length, location: 'upload', depth: 0, source: bufferSource(upload) }, bufferSink(), { depth: 0 });
      const findings = typeof r === 'string' ? [] : (r.findings ?? []);
      expect({ seen, found: findings.map(f => `${kind(f)} ${f.attachment}`) }).to.deep.equal({
        seen: ['box upload.box 0/0', 'xml page.html 1/1', 'image - 2/2', 'image logo.png 1/1'],
        found: ['IMAGE/EXIF page.html > unnamed file', 'EMBEDDED/PLUGIN_PASSED page.html', 'SCRIPT/ELEMENT page.html', 'IMAGE/EXIF logo.png'],
      });
    });

    it('reports the findings from inside a file with its path, and turns a reject inside it into the removal of the file', async () => {
      const r = await disarm(page(`<img src="${pngUrl}" alt="k">`), { filePlugins: [imagePlugin([exif, comment])] });
      expect(r.before.findings.map(f => ({ kind: kind(f), action: f.action, attachment: f.attachment, weight: f.weight }))).to.deep.equal([
        { kind: 'IMAGE/EXIF', action: 'strip', attachment: 'unnamed file', weight: 30 },
        { kind: 'IMAGE/COMMENT', action: 'strip', attachment: 'unnamed file', weight: undefined },
        { kind: 'EMBEDDED/PLUGIN_PASSED', action: 'info', attachment: undefined, weight: undefined },
      ]);
      expect({ status: r.status, score: r.before.score }).to.deep.equal({ status: 'defused', score: 30 });
    });

    it("scores by the caller's weights, then the built-in table, then the finding's weight, then 0", () => {
      expect({
        spec: findingSpec('IMAGE', 'EXIF'),
        exif: scoreFindings([exif], {}).score,
        comment: scoreFindings([comment], {}).score,
        own: scoreFindings([{ ...exif, category: C.Script, detail: D.Element, weight: 5 }], {}).score,
        caller: scoreFindings([exif], { scoreWeights: [{ category: 'IMAGE' as C, weight: 12 }] }).score,
      }).to.deep.equal({ spec: undefined, exif: 30, comment: 0, own: 70, caller: 12 });
    });

    it('passes a limit from a plugin up to the upload, which rejects for it', async () => {
      const limit = Object.assign(new Error('nesting limit in another package'), { code: 'DEFUSE_LIMIT', limit: 'nesting' });
      for (const from of ['accepts', 'process'] as const) {
        const r = await disarm(page(`<img src="${pngUrl}">`), { filePlugins: [throwing(from, limit)] });
        expect({ status: r.status, score: r.before.score, stop: r.before.findings.filter(f => f.action === 'reject').map(kind) }, from).to.deep.equal({
          status: 'rejected',
          score: null,
          stop: ['LIMIT/NESTING_DEPTH'],
        });
      }
      // A file inside another passes the limit on, so the tree stops at its top.
      const e = await rejection(xmlPlugin({ filePlugins: [throwing('process', limit)] }).process(asFile(page(`<img src="${pngUrl}">`), 'p.html'), bufferSink(), { depth: 1 }));
      expect(e).to.equal(limit);
    });

    it('passes an I/O error from a plugin or from inside a file up as an error, never as a verdict', async () => {
      const cause = Object.assign(new Error('EIO: disk'), { code: 'EIO' });
      const io = Object.assign(new Error('EIO: disk'), { code: 'DEFUSE_IO', cause });
      expect(await rejection(disarmXml(Buffer.from(page(`<img src="${pngUrl}">`)), { filePlugins: [throwing('process', io)] }))).to.equal(cause);
      // xmlPlugin wraps an I/O error from the file it reads.
      const failing: ContainedFile = {
        size: 100,
        location: 'entry',
        depth: 1,
        source: {
          size: async () => 100,
          read: async () => {
            throw cause;
          },
        },
      };
      const e = await rejection(xmlPlugin().process(failing, bufferSink(), { depth: 1 }));
      expect(e).to.include({ code: 'DEFUSE_IO' });
      expect((e as { cause?: unknown }).cause).to.equal(cause);
    });

    it('treats any other error from a plugin as that plugin failing, and removes the file', async () => {
      const r = await disarm(page(`<img src="${pngUrl}" alt="k">`), { filePlugins: [throwing('process', Object.assign(new Error('EIO'), { code: 'EIO' }))] });
      expect({ status: r.status, kinds: r.before.findings.map(kind), plugin: r.before.findings[0]?.data?.plugin }).to.deep.equal({
        status: 'defused',
        kinds: ['EMBEDDED/PLUGIN_FAILED'],
        plugin: 'thrower',
      });
      expect(has(r.before, 'EMBEDDED/PLUGIN_FAILED')).to.equal(true);
      // The plugin did not answer, so the file scores as one no plugin accepts.
      expect(r.before.score).to.equal(30);
    });
  });
});
