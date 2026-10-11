import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from 'chai';
import { PNG, page, runCli, svg } from './helpers/util';

/** The fields of `inspect --json` output the tests read. */
interface InspectJson {
  status: string;
  format: string;
  findings: Array<{ category: string; detail: string; action: string; location?: string }>;
}

const json = (stdout: Buffer) => JSON.parse(stdout.toString()) as InspectJson;
const kinds = (r: InspectJson) => r.findings.map(f => `${f.category}/${f.detail}`);

describe('command-line tool', () => {
  let dir: string;
  const file = (name: string) => path.join(dir, name);
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xml-defuse-cli-'));
    fs.writeFileSync(file('clean.html'), page('<p>k</p>'));
    fs.writeFileSync(file('script.html'), page('<script>x()</script><p>k</p>'));
    fs.writeFileSync(file('tool.hta'), page('<p>k</p>'));
    fs.writeFileSync(file('binary.bin'), Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(
      file('images.html'),
      page(`<img src="data:image/png;base64,${PNG.toString('base64')}"><img src="data:image/svg+xml;base64,${Buffer.from(svg('<script>x()</script><rect/>')).toString('base64')}">`),
    );
    fs.writeFileSync(file('meta.html'), page('<meta name="author" content="Someone"><p>k</p>'));
    fs.writeFileSync(file('deep.xml'), `<r>${'<a>'.repeat(20)}${'</a>'.repeat(20)}</r>`);
    // A tag name may hold control characters, and the location of a finding names the tag.
    fs.writeFileSync(file('control.html'), page('<x\u0007\u001b[31m onclick="y()">k</x>'));
    fs.writeFileSync(file('plugin.js'), "module.exports = { plugins: [{ kind: 'file', name: 'keepall', accepts: () => true, process: async () => ({ result: 'passed' }) }] };\n");
    fs.writeFileSync(file('config.js'), "module.exports = { actionOverrides: [{ category: 'SCRIPT', action: 'reject' }], limits: { depth: 5 } };\n");
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('inspects with exit codes 0, 1 and 2', () => {
    expect(runCli(['inspect', file('clean.html')]).status).to.equal(0);
    const script = runCli(['inspect', file('script.html')]);
    expect([script.status, script.stdout.toString().split('\n')[0]]).to.deep.equal([1, 'inspection: strippable, risk HIGH (score 70), html, utf-8']);
    expect(script.stdout.toString()).to.include('strip  SCRIPT/ELEMENT [line 3, <script>]');
    expect(runCli(['inspect', file('binary.bin')]).status).to.equal(2);
  });

  it('prints JSON', () => {
    const r = json(runCli(['inspect', file('script.html'), '--json']).stdout);
    expect({ status: r.status, format: r.format, kinds: kinds(r) }).to.deep.equal({ status: 'strippable', format: 'html', kinds: ['SCRIPT/ELEMENT'] });
  });

  it('defuses to a file and to stdout, reading stdin, and prints the report where the output is not', () => {
    const out = file('out.html');
    const r = runCli(['defuse', file('script.html'), out]);
    expect([r.status, r.stdout.toString().split('\n')[0]]).to.deep.equal([1, 'result: defused']);
    expect(fs.readFileSync(out, 'utf8')).to.not.include('<script');
    const piped = runCli(['defuse', '-', '-'], { input: fs.readFileSync(file('script.html')) });
    expect(piped.status).to.equal(1);
    expect(Buffer.compare(piped.stdout, fs.readFileSync(out))).to.equal(0);
    expect(piped.stderr.toString()).to.include('result: defused');
  });

  it('rejects any file named .hta, and writes no output file for a rejected defuse', () => {
    const out = file('rejected.html');
    const r = runCli(['defuse', file('tool.hta'), out]);
    expect([r.status, r.stdout.toString()]).to.satisfy(([status, text]: [number, string]) => status === 2 && text.includes('FORMAT/HTA'));
    expect(fs.existsSync(out)).to.equal(false);
    // From stdin there is no name, so the same bytes are an ordinary page.
    expect(runCli(['inspect', '-'], { input: fs.readFileSync(file('tool.hta')) }).status).to.equal(0);
  });

  it('keeps types with --keep-type, defuses markup inside with --defuse-embedded-markup, and loads plugin modules', () => {
    const embedded = (args: string[]) =>
      json(runCli(['inspect', file('images.html'), ...args, '--json']).stdout)
        .findings.filter(f => f.category === 'EMBEDDED')
        .map(f => f.detail);
    expect(embedded([])).to.deep.equal(['NO_PLUGIN', 'NO_PLUGIN']);
    expect(embedded(['--keep-type', 'image/png'])).to.deep.equal(['PLUGIN_PASSED', 'NO_PLUGIN']);
    expect(embedded(['--keep-type', 'png', '--defuse-embedded-markup'])).to.deep.equal(['NO_PLUGIN', 'PLUGIN_SCRUBBED']);
    expect(embedded(['--plugin', file('plugin.js')])).to.deep.equal(['PLUGIN_PASSED', 'PLUGIN_PASSED']);
    const bad = runCli(['inspect', file('clean.html'), '--plugin', file('config.js')]);
    expect([bad.status, bad.stderr.toString().split('\n')[0]]).to.deep.equal([3, 'A plugin module must export plugins with kind "file"']);
  });

  it('strips metadata with --strip-metadata', () => {
    const r = runCli(['defuse', file('meta.html'), file('meta.out.html'), '--strip-metadata']);
    expect(r.status).to.equal(1);
    expect(fs.readFileSync(file('meta.out.html'), 'utf8')).to.not.include('Someone');
    expect(runCli(['inspect', file('meta.html')]).status).to.equal(0);
  });

  it('loads a config module, and applies --limit on top of it', () => {
    const rejects = (args: string[]) => {
      const r = runCli(['inspect', ...args, '--json']);
      return {
        status: r.status,
        rejects: json(r.stdout)
          .findings.filter(f => f.action === 'reject')
          .map(f => `${f.category}/${f.detail}`),
      };
    };
    expect(rejects([file('script.html'), '--config', file('config.js')])).to.deep.equal({ status: 2, rejects: ['SCRIPT/ELEMENT'] });
    expect(rejects([file('deep.xml'), '--config', file('config.js')])).to.deep.equal({ status: 2, rejects: ['LIMIT/DEPTH'] });
    expect(rejects([file('deep.xml'), '--config', file('config.js'), '--limit', 'depth=100'])).to.deep.equal({ status: 0, rejects: [] });
    expect(rejects([file('clean.html'), '--limit', 'fileSize=0.01kb'])).to.deep.equal({ status: 2, rejects: ['LIMIT/FILE_SIZE'] });
  });

  it('writes control characters from the file as escapes', () => {
    const text = runCli(['inspect', file('control.html')]).stdout.toString();
    expect(text).to.include('\\u0007\\u001b[31m').and.not.include('\u001b');
  });

  it('exits 3 on usage and I/O errors, and never echoes what follows "=" in an unknown option', () => {
    expect(runCli([]).status).to.equal(3);
    expect(runCli(['inspect']).status).to.equal(3);
    expect(runCli(['scan', file('clean.html')]).status).to.equal(3);
    const bogus = runCli(['inspect', file('clean.html'), '--bogus=secret']);
    expect([bogus.status, bogus.stderr.toString().split('\n')[0]]).to.deep.equal([3, 'Unknown option --bogus=...']);
    for (const limit of ['depth=abc', 'nope=1', 'fileSize=lots', 'depth']) expect(runCli(['inspect', file('clean.html'), '--limit', limit]).status, limit).to.equal(3);
    expect(runCli(['defuse', file('missing.html'), file('x.html')]).status).to.equal(3);
    const same = runCli(['defuse', file('clean.html'), file('clean.html')]);
    expect([same.status, same.stderr.toString().split('\n')[0]]).to.deep.equal([3, 'The input and the output are the same file']);
    expect(fs.readFileSync(file('clean.html'), 'utf8')).to.equal(page('<p>k</p>'));
  });
});
