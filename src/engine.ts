import * as crypto from 'node:crypto';
import { TextDecoder } from 'node:util';
import { bomOf, decoderFor, encodingFor, isUtf7Label, prescan } from './encoding';
import { checkTime, isIoError, NestedIoError, NestingLimitError, StopError, stopsTree } from './errors';
import { FindingFactory } from './findings';
import { HtmlTokenizer } from './html';
import { bufferSink, bufferSource, copyToSink, SpillSink, TempDir } from './io';
import { type MarkupElement, NS } from './markup';
import { contentType, leafParts, type MhtFile, type MhtPart, type PartOutput, readMht, writeMht } from './mht';
import { type FileDecision, FindingList, LimitText, Memo, Rules, type RunCtx, USE_LIMIT } from './rules';
import { scoreFindings } from './score';
import { extensionOf, isOfficeXml, sniffMarkup, sniffType, typeFromName, typesDisagree } from './sniff';
import { HtmlTree } from './tree';
import {
  type ByteSink,
  type ByteSource,
  XmlCategory as C,
  type ContainedFile,
  type ContainedFileResult,
  XmlDetail as D,
  type DefuseFinding,
  type PluginContext,
  type XmlDisarmResult,
  type XmlFormat,
  type XmlInspection,
  type XmlLimits,
  type XmlOptions,
  XmlRisk,
} from './types';
import { decodeDataUrl } from './url';
import { HtmlWriter, OutputBuffer, XmlWriter } from './writer';
import { type EntityBudget, type XmlElement, XmlTokenizer } from './xml';

const DEFAULT_LIMITS = {
  xmlDepth: 256,
  htmlDepth: 4096,
  tokenSize: 16 * 1024 * 1024,
  entityDepth: 16,
  entityExpansions: 100_000,
  entitySize: 16 * 1024 * 1024,
  parts: 10_000,
  decodedBytes: 512 * 1024 * 1024,
};

type Limits = typeof DEFAULT_LIMITS & Pick<XmlLimits, 'fileSize' | 'nestingDepth' | 'timeMs'>;

function resolveLimits(given: XmlLimits = {}): Limits {
  return {
    xmlDepth: given.depth ?? DEFAULT_LIMITS.xmlDepth,
    htmlDepth: given.depth ?? DEFAULT_LIMITS.htmlDepth,
    tokenSize: given.tokenSize ?? DEFAULT_LIMITS.tokenSize,
    entityDepth: given.entityDepth ?? DEFAULT_LIMITS.entityDepth,
    entityExpansions: given.entityExpansions ?? DEFAULT_LIMITS.entityExpansions,
    entitySize: given.entitySize ?? DEFAULT_LIMITS.entitySize,
    parts: given.parts ?? DEFAULT_LIMITS.parts,
    decodedBytes: given.decodedBytes ?? DEFAULT_LIMITS.decodedBytes,
    fileSize: given.fileSize,
    nestingDepth: given.nestingDepth,
    timeMs: given.timeMs,
  };
}

/** The key under which the engine hands its run's options to a plugin. No other package can name it. */
export const RUN_OPTIONS = Symbol('xml-defuse run options');

/** A plugin context as the engine makes it. */
export type RunContext = PluginContext & { [RUN_OPTIONS]?: XmlOptions };

/** What a plugin kept, so the check of the output knows it again by its content. */
interface Expected {
  result: 'passed' | 'scrubbed';
  plugin: string;
  findings?: DefuseFinding[];
}

const CHUNK = 65536;
const MIME_TYPES: Record<XmlFormat, string> = {
  html: 'text/html',
  xhtml: 'application/xhtml+xml',
  svg: 'image/svg+xml',
  xslt: 'application/xslt+xml',
  xml: 'application/xml',
  mht: 'multipart/related',
  '': '',
};

/** What one analysis holds open. Whoever starts the run releases it with cleanup(), however the run ends. */
class Run {
  readonly temp: TempDir;
  readonly factory: FindingFactory;
  readonly limits: Limits;
  /** What the plugins kept, by the hash of the bytes kept. */
  readonly kept = new Map<string, Expected>();
  /** Memory held by the copies plugins scrubbed. */
  retained = 0;
  readonly sinks: SpillSink[] = [];
  readonly budget: EntityBudget = { expansions: 0, size: 0 };
  readonly threshold: number;

  constructor(
    readonly options: XmlOptions,
    readonly depth: number,
    readonly deadline: number | undefined,
    /** Set when the run checks the engine's own output. */
    readonly verify?: Map<string, Expected>,
  ) {
    this.temp = new TempDir(options.tempDir);
    this.factory = new FindingFactory(options.actionOverrides);
    this.limits = resolveLimits(options.limits);
    this.threshold = options.memoryThreshold ?? 8 * 1024 * 1024;
  }

  check = (): void => checkTime(this.deadline);

  spill(threshold = this.threshold): SpillSink {
    const s = new SpillSink(this.temp, threshold);
    this.sinks.push(s);
    return s;
  }

  async cleanup(): Promise<void> {
    try {
      for (const s of this.sinks) await s.dispose().catch(() => undefined);
    } finally {
      await this.temp.cleanup();
    }
  }
}

/** How one markup document is read, decided by the first pass for the second. */
interface MarkupPlan {
  mode: 'xml' | 'html';
  /** For HTML, the encoding the text was decoded with, and the length of its byte order mark. */
  encoding: string;
  bom: number;
  /** For XML, the declaration the output starts with, when it needs one. */
  declaration?: { standalone: boolean };
  /** For HTML, the document looked like XML, so the output starts with the HTML5 document type declaration. */
  html5?: boolean;
  memo: Memo;
  keyPrefix: string;
  locPrefix: string;
  format: XmlFormat;
  isPart?: (url: string) => 'kept' | 'dropped' | undefined;
}

type PartPlan =
  | { kind: 'markup'; plan: MarkupPlan }
  | { kind: 'css'; text: string; memo: Memo; keyPrefix: string; locPrefix: string }
  | { kind: 'file'; decision: FileDecision; replacement?: SpillSink }
  | { kind: 'drop' };

type Plan = { kind: 'markup'; markup: MarkupPlan } | { kind: 'mht'; file: MhtFile; parts: Map<number, PartPlan> };

interface Analysis {
  inspection: XmlInspection;
  plan?: Plan;
}

const PLUGIN_KEPT = new Set<string>([D.PluginPassed, D.PluginScrubbed]);

/**
 * `incomplete` marks a run that could not inspect the whole file. finish() rejects it without a score, whatever the
 * actions say, because an override can make the finding that stopped it look harmless.
 */
function finish(findings: DefuseFinding[], options: XmlOptions, incomplete: boolean, format: XmlFormat, encoding: string, isOutput = false): XmlInspection {
  const named = { format, mimeType: MIME_TYPES[format], encoding };
  if (incomplete) return { status: 'rejected', score: null, risk: XmlRisk.Unknown, findings, ...named };
  const rejected = findings.some(f => f.action === 'reject');
  // In an upload, a plugin rewrite or a metadata strip changes the file, so the output must be written.
  const strippable = findings.some(f => f.action === 'strip' || (!isOutput && (f.detail === D.PluginScrubbed || f.detail === D.Stripped)));
  // The upload's score leaves out what plugins kept; the output's score counts it.
  const { score, risk } = scoreFindings(isOutput ? findings : findings.filter(f => !PLUGIN_KEPT.has(f.detail)), options);
  return { status: rejected ? 'rejected' : strippable ? 'strippable' : 'clean', score, risk, findings, ...named };
}

function makeCtx(run: Run, findings: FindingList | undefined, memo: Memo, isPart?: (url: string) => 'kept' | 'dropped' | undefined): RunCtx {
  return {
    factory: run.factory,
    findings,
    memo,
    stripMetadata: run.options.stripMetadata === true && run.verify === undefined,
    tokenSize: run.limits.tokenSize,
    htmlDepth: run.limits.htmlDepth,
    jobs: [],
    isPart,
    metadataRemoved: 0,
    rejected: false,
  };
}

/** Runs `fn` on a source and closes the source after, so a temporary file's handle never waits for garbage collection. */
async function using<T>(source: ByteSource, fn: (s: ByteSource) => Promise<T>): Promise<T> {
  try {
    return await fn(source);
  } finally {
    await source.close?.();
  }
}

async function hashSource(source: ByteSource): Promise<string> {
  const h = crypto.createHash('sha256');
  const size = await source.size();
  for (let pos = 0; pos < size; pos += 262144) h.update(await source.read(pos, Math.min(262144, size - pos)));
  return h.digest('hex');
}

/** The type the content sniffs as, including the markup formats this package reads. */
async function sniffSource(source: ByteSource, size: number): Promise<string | undefined> {
  const head = await source.read(0, Math.min(size, 4096));
  const t = sniffType(head.subarray(0, 1024));
  if (t) return t;
  const m = sniffMarkup(head);
  return m ? (m.kind === 'mht' ? 'multipart/related' : m.kind === 'html' ? 'text/html' : 'application/xml') : undefined;
}

/**
 * Hands a whole file found inside the document to the plugins, as pdf-defuse hands an attached file. Returns what
 * the rewrite does with it. The file's findings, and those from inside it, go to `out`.
 */
async function decideFile(
  run: Run,
  file: { source: ByteSource; size: number; name?: string; declaredType?: string; location: string },
  out: DefuseFinding[],
): Promise<{ keep: boolean; replacement?: SpillSink }> {
  const make = (d: D, data: Record<string, string | number>) => {
    const f = run.factory.make(C.Embedded, d, file.location, data);
    out.push(f);
    return f;
  };
  // Content that goes whatever an override says shows the action that removed it.
  const removal = (d: D, data: Record<string, string | number>) => {
    const f = make(d, data);
    if (f.action === 'info') f.action = 'strip';
  };
  const name = file.name;
  const pushContained = (found: DefuseFinding[] | undefined) => {
    const label = name || 'unnamed file';
    for (const f of found ?? []) {
      out.push({
        ...f,
        action: f.action === 'reject' ? 'strip' : f.action,
        location: f.location ? `${file.location} > ${f.location}` : file.location,
        data: f.data && { ...f.data },
        attachment: f.attachment ? `${label} > ${f.attachment}` : label,
      });
    }
  };
  const hash = await hashSource(file.source);
  const expected = run.verify?.get(hash);
  if (expected) {
    make(expected.result === 'passed' ? D.PluginPassed : D.PluginScrubbed, { plugin: expected.plugin, name: name ?? '' });
    pushContained(expected.findings);
    return { keep: true };
  }
  const sniffed = await sniffSource(file.source, file.size);
  const typeData = { name: name ?? '', declared: file.declaredType ?? '', sniffed: sniffed ?? '', nameType: typeFromName(name) ?? '' };
  if (typesDisagree(file.declaredType, name, sniffed) && make(D.TypeMismatch, typeData).action === 'strip') return { keep: false };
  const cf: ContainedFile = { name, declaredType: file.declaredType, sniffedType: sniffed, size: file.size, location: file.location, depth: run.depth + 1, source: file.source };
  const context: RunContext = { depth: cf.depth, deadline: run.deadline, [RUN_OPTIONS]: run.options };
  const passOn = (e: unknown) => {
    const code = stopsTree(e);
    if (code === 'DEFUSE_IO') {
      const cause = (e as { cause?: unknown }).cause ?? e;
      run.temp.ioError ??= cause;
      throw cause;
    }
    if (code === 'DEFUSE_LIMIT') throw e;
  };
  for (const plugin of run.options.filePlugins ?? []) {
    try {
      if (!(await plugin.accepts(cf))) continue;
    } catch (e) {
      passOn(e);
      continue;
    }
    // Scrubbed copies wait in memory until the write, so all of them together stay under one threshold.
    const outSink = run.spill(Math.max(0, run.threshold - run.retained));
    try {
      const o = await plugin.process(cf, outSink, context);
      const r: Partial<ContainedFileResult> = typeof o === 'string' ? { result: o } : (o ?? {});
      await outSink.close();
      const data = { plugin: plugin.name, name: name ?? '' };
      pushContained(r.findings);
      // The check of the output knows a kept file by the hash of the bytes kept.
      const keptHash = outSink.length > 0 ? await using(outSink.source(), hashSource) : hash;
      if (r.result === 'passed') {
        make(D.PluginPassed, data);
        run.kept.set(keptHash, { result: 'passed', plugin: plugin.name, findings: r.outputFindings });
      } else if (r.result === 'scrubbed' && outSink.length > 0) {
        make(D.PluginScrubbed, data);
        run.kept.set(keptHash, { result: 'scrubbed', plugin: plugin.name, findings: r.outputFindings });
      } else {
        removal(r.result === 'removed' ? D.PluginRemoved : D.PluginFailed, data);
        return { keep: false };
      }
      if (outSink.length === 0) return { keep: true };
      if (!outSink.spilled) run.retained += outSink.length;
      return { keep: true, replacement: outSink };
    } catch (e) {
      passOn(e);
      removal(D.PluginFailed, { plugin: plugin.name, name: name ?? '' });
      return { keep: false };
    }
  }
  const f = make(D.NoPlugin, { name: name ?? '', type: file.declaredType ?? sniffed ?? '', sniffed: sniffed ?? '' });
  return { keep: f.action !== 'strip' };
}

/** Runs the plugins on the data: URLs the first pass queued, and fills their places in the report. */
async function drainJobs(run: Run, ctx: RunCtx): Promise<void> {
  while (ctx.jobs.length) {
    const job = ctx.jobs.shift();
    if (!job) break;
    run.check();
    const found: DefuseFinding[] = [];
    const decoded = decodeDataUrl(job.url);
    if (!decoded) {
      const f = run.factory.make(C.Embedded, D.NoPlugin, job.location, { name: '', reason: 'cannot decode' });
      if (f.action === 'info') f.action = 'strip';
      found.push(f);
      ctx.memo.files.set(job.key, { keep: false });
    } else {
      if (decoded.bytes.length > run.limits.decodedBytes)
        throw new StopError(C.Limit, D.DecodedSize, 'A data: URL decodes larger than the decoded size limit', { limit: run.limits.decodedBytes }, job.location);
      const r = await decideFile(run, { source: bufferSource(decoded.bytes), size: decoded.bytes.length, declaredType: decoded.type, location: job.location, name: job.name }, found);
      let replacement: string | undefined;
      if (r.replacement) {
        const length = r.replacement.length;
        const b = Buffer.from(await using(r.replacement.source(), s => s.read(0, length)));
        replacement = `data:${decoded.type};base64,${b.toString('base64')}`;
      }
      ctx.memo.files.set(job.key, r.keep ? { keep: true, replacement } : { keep: false });
    }
    ctx.findings?.fill(job.slot, found);
  }
}

/** The format an XML document's root element gives it. */
function formatOf(ctx: RunCtx): XmlFormat {
  const r = ctx.root;
  if (!r) return 'xml';
  if (r.ns === NS.svg && r.local === 'svg') return 'svg';
  if ((r.ns === NS.xslt && (r.local === 'stylesheet' || r.local === 'transform')) || r.xsltVersion) return 'xslt';
  if (r.ns === NS.html) return 'xhtml';
  return 'xml';
}

/**
 * The encoding of HTML bytes, as the WHATWG encoding sniffing algorithm picks it: a byte order mark, then the
 * container's charset, then a meta element in the first 1024 bytes. With none of these, the text is read as UTF-8
 * when the first 64 KiB are valid UTF-8, as browsers detect it, and as windows-1252 otherwise.
 */
function htmlEncoding(head: Uint8Array, transport: string | undefined, whole: boolean): { encoding: string; bom: number; utf7: boolean } {
  const bom = bomOf(head);
  if (bom) return { encoding: bom.encoding, bom: bom.length, utf7: false };
  const start = Buffer.from(head.buffer, head.byteOffset, Math.min(head.byteLength, 1024)).toString('latin1');
  const utf7 = (transport !== undefined && isUtf7Label(transport)) || /(charset|encoding)\s*=\s*["']?\s*(utf-?7|unicode-1-1-utf-7|csunicode11utf7)\b/i.test(start);
  const declared = transport === undefined ? undefined : encodingFor(transport);
  if (declared) return { encoding: declared, bom: 0, utf7 };
  const meta = prescan(head);
  if (meta) return { encoding: meta.encoding, bom: 0, utf7 };
  // An XML declaration's encoding, which Chromium also reads in a page.
  const xml = /^\s*<\?xml\s[^>]*?\bencoding\s*=\s*["']([^"']+)["']/.exec(start)?.[1];
  const fromXml = xml === undefined ? undefined : encodingFor(xml);
  if (fromXml && !fromXml.startsWith('utf-16')) return { encoding: fromXml, bom: 0, utf7 };
  try {
    // A sequence cut at the end of the bytes read counts as valid unless they are the whole file.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: !whole });
    return { encoding: 'utf-8', bom: 0, utf7 };
  } catch {
    return { encoding: 'windows-1252', bom: 0, utf7 };
  }
}

/** The adapter from the XML tokenizer's events to the rules. */
function xmlTokenizer(run: Run, rules: Rules, onLine: (line: number) => void): XmlTokenizer {
  const stack: MarkupElement[] = [];
  let index = 0;
  let line = 1;
  const markup = (el: XmlElement): MarkupElement => ({
    qname: el.qname,
    local: el.local,
    ns: el.ns,
    attributes: el.attributes,
    namespaces: el.namespaces,
    line: el.line,
    empty: el.empty,
    html: false,
    index: index++,
  });
  const limits = { depth: run.limits.xmlDepth, tokenSize: run.limits.tokenSize, entityDepth: run.limits.entityDepth, entityExpansions: run.limits.entityExpansions, entitySize: run.limits.entitySize };
  return new XmlTokenizer(
    {
      start: el => {
        line = el.line;
        onLine(line);
        const m = markup(el);
        stack.push(m);
        rules.start(m);
      },
      end: () => {
        const m = stack.pop();
        if (m) rules.end(m, true);
      },
      text: t => rules.text(t),
      comment: (t, l) => rules.comment(t, l, false),
      instruction: (target, data, l) => rules.instruction(target, data, l),
    },
    limits,
    'document',
    {
      notes: {
        doctype: d => rules.doctype({ name: d.name, publicId: d.publicId, systemId: d.systemId, subset: d.subset, entities: d.entities, externalEntities: d.externalEntities, line: d.line }),
        externalEntity: r => rules.externalEntity(r.name, r.systemId, line),
        externalParameter: (name, systemId) => rules.externalEntity(`%${name}`, systemId, line),
      },
      budget: run.budget,
    },
  );
}

/**
 * Reads a markup document with the plan's syntax, running the rules, and with `out` writing what they keep. In the
 * first pass it fills in the plan's encoding.
 */
async function readMarkup(run: Run, src: ByteSource, plan: MarkupPlan, ctx: RunCtx, out?: { buf: OutputBuffer; sink: ByteSink }): Promise<Rules> {
  const writer = out ? (plan.mode === 'html' ? new HtmlWriter(out.buf, plan.html5) : new XmlWriter(out.buf, plan.declaration)) : undefined;
  const rules = new Rules(ctx, { html: plan.mode === 'html', keyPrefix: plan.keyPrefix, locPrefix: plan.locPrefix, lineOffset: 0, writer });
  const flush = async () => {
    if (out && out.buf.pending >= CHUNK) await out.sink.write(out.buf.take());
  };
  const size = await src.size();
  if (plan.mode === 'xml') {
    const t = xmlTokenizer(run, rules, () => undefined);
    for (let pos = 0; pos < size; pos += CHUNK) {
      run.check();
      t.write(await src.read(pos, Math.min(CHUNK, size - pos)));
      await drainJobs(run, ctx);
      await flush();
    }
    t.end();
    plan.encoding = t.encodingName;
  } else {
    const decoder = decoderFor(plan.encoding);
    const tree = new HtmlTree(rules, run.limits.htmlDepth);
    const tokenizer = new HtmlTokenizer(tree, run.limits.tokenSize);
    tree.attach(tokenizer);
    for (let pos = plan.bom; pos < size; pos += CHUNK) {
      run.check();
      tokenizer.write(decoder.decode(await src.read(pos, Math.min(CHUNK, size - pos)), { stream: true }));
      await drainJobs(run, ctx);
      await flush();
    }
    tokenizer.write(decoder.decode());
    tokenizer.end();
    tree.finish();
  }
  await drainJobs(run, ctx);
  if (out) await out.sink.write(out.buf.take());
  return rules;
}

/** The number of elements the renderer builds for the drawing, use references followed, up to a cap. */
function useTotal(root: Rules['uses'], graph: Memo['useGraph']): number {
  type Node = Rules['uses'];
  const cost = new Map<Node, number>();
  const visiting = new Set<Node>();
  const deps = (n: Node) => [...n.children, ...n.uses].map(id => graph.get(id)).filter((d): d is Node => d !== undefined);
  const stack: Array<[Node, boolean]> = [[root, false]];
  while (stack.length) {
    const top = stack.pop();
    if (!top) break;
    const [node, expanded] = top;
    if (cost.has(node)) continue;
    if (!expanded) {
      visiting.add(node);
      stack.push([node, true]);
      for (const d of deps(node)) if (!cost.has(d) && !visiting.has(d)) stack.push([d, false]);
      continue;
    }
    let total = node.elements;
    for (const id of node.children) total += cost.get(graph.get(id) ?? node) ?? 0;
    // A use in a cycle counts only itself, since renderers refuse the cycle.
    for (const id of node.uses) {
      const t = graph.get(id);
      total += 1 + (t && t !== node ? (cost.get(t) ?? 0) : 0);
    }
    cost.set(node, Math.min(total, USE_LIMIT * 16));
    visiting.delete(node);
  }
  return cost.get(root) ?? 0;
}

/** The findings the first pass can make only once it has read the whole document. */
function finishDocument(run: Run, ctx: RunCtx, rules: Rules, locPrefix: string): void {
  const memo = ctx.memo;
  const report = (c: C, d: D, location: string | undefined, data: Record<string, string | number>, forceStrip = false) => {
    const f = run.factory.make(c, d, location, data);
    if (forceStrip && f.action === 'info') f.action = 'strip';
    ctx.findings?.push(f);
    return f.action;
  };
  if (memo.useGraph.size || rules.uses.uses.length) {
    const total = useTotal(rules.uses, memo.useGraph);
    if (total > USE_LIMIT) memo.useAction = report(C.Svg, D.UseAmplification, `${locPrefix}use elements`, { total, limit: USE_LIMIT });
  }
  for (const call of memo.xsltCalls) {
    if (memo.xsltFunctions.has(call.ns)) continue;
    const action = report(C.Xslt, D.ExtensionFunction, call.location, { function: call.name, namespace: call.ns.slice(0, 200) });
    // Calls in the text of one element share its key, and one that strips drops the element.
    if (memo.xslt.get(call.key) !== 'strip') memo.xslt.set(call.key, action);
  }
  if (ctx.metadataRemoved) report(C.Metadata, D.Stripped, locPrefix || undefined, { count: ctx.metadataRemoved });
  if (ctx.unnamedRemoval) report(C.Processing, D.ContentRemoved, locPrefix || undefined, { content: ctx.unnamedRemoval }, true);
}

/**
 * The first pass over one markup document. A document that sniffs as XML is read as XML; if it is not well-formed,
 * it is read again as HTML, as a browser reads a page, and the XML attempt's findings are dropped.
 */
async function analyzeMarkup(
  run: Run,
  src: ByteSource,
  findings: FindingList,
  where: { keyPrefix: string; locPrefix: string; transport?: string; isPart?: (url: string) => 'kept' | 'dropped' | undefined; mode?: 'xml' | 'html' },
): Promise<MarkupPlan> {
  const size = await src.size();
  const head = await src.read(0, Math.min(size, CHUNK));
  const sniff = sniffMarkup(head);
  const mode = where.mode ?? (sniff?.kind === 'xml' ? 'xml' : 'html');
  if (mode === 'xml') {
    const attempt = new FindingList();
    const memo = new Memo();
    const ctx = makeCtx(run, attempt, memo, where.isPart);
    const plan: MarkupPlan = { mode: 'xml', encoding: 'utf-8', bom: 0, memo, keyPrefix: where.keyPrefix, locPrefix: where.locPrefix, format: 'xml', isPart: where.isPart };
    try {
      const rules = await readMarkup(run, src, plan, ctx);
      finishDocument(run, ctx, rules, where.locPrefix);
      findings.merge(attempt);
      plan.format = formatOf(ctx);
      const declText = Buffer.from(head.subarray(0, 1024)).toString('latin1');
      if (sniff?.declared || plan.encoding !== 'utf-8') plan.declaration = { standalone: /^[^>]*\bstandalone\s*=\s*["']yes["']/.test(declText.replace(/^\uFEFF|^\xef\xbb\xbf/, '')) };
      return plan;
    } catch (e) {
      if (!(e instanceof StopError) || e.category !== C.Xml || where.mode === 'xml') {
        findings.merge(attempt);
        throw e;
      }
      // Markup that only looked like XML says nothing. A file that said it is XML, by its declaration, a namespace on its
      // first element or its document type, does.
      if (sniff?.xml) {
        const f = run.factory.make(C.Xml, e.detail === D.Encoding ? D.Encoding : D.Malformed, where.locPrefix ? where.locPrefix.replace(/, $/, '') : undefined, {
          reason: String(e.data?.reason ?? e.message).slice(0, 200),
        });
        if (f.action === 'info') f.action = 'strip';
        findings.push(f);
      }
    }
  }
  const enc = htmlEncoding(head, where.transport, head.length === size);
  const memo = new Memo();
  const list = new FindingList();
  const ctx = makeCtx(run, list, memo, where.isPart);
  if (enc.utf7) list.push(run.factory.make(C.Format, D.Utf7, `${where.locPrefix}line 1`, {}));
  const plan: MarkupPlan = {
    mode: 'html',
    encoding: enc.encoding,
    bom: enc.bom,
    memo,
    keyPrefix: where.keyPrefix,
    locPrefix: where.locPrefix,
    format: 'html',
    isPart: where.isPart,
    html5: mode === 'xml',
  };
  try {
    const rules = await readMarkup(run, src, plan, ctx);
    finishDocument(run, ctx, rules, where.locPrefix);
  } finally {
    findings.merge(list);
  }
  return plan;
}

const MARKUP_TYPES = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml']);

/**
 * Whether a reference in an MHT part names another part: by Content-Location, resolved against the part's own, or by
 * Content-ID. A part the first pass has not decided yet counts as kept.
 */
function partResolver(file: MhtFile, part: MhtPart, plans: Map<number, PartPlan>): (url: string) => 'kept' | 'dropped' | undefined {
  const locations = new Map<string, number>();
  const ids = new Map<string, number>();
  const status = (index: number | undefined) => {
    if (index === undefined) return undefined;
    const p = plans.get(index);
    return p?.kind === 'drop' || (p?.kind === 'file' && !p.decision.keep) ? 'dropped' : 'kept';
  };
  const norm = (u: string, base?: string) => {
    try {
      return new URL(u, base).href;
    } catch {
      return u.trim();
    }
  };
  for (const p of leafParts(file.parts)) {
    if (p.location) {
      locations.set(p.location.trim(), p.index);
      locations.set(norm(p.location), p.index);
    }
    if (p.contentId) ids.set(p.contentId.toLowerCase(), p.index);
  }
  return (url: string) => {
    const u = url.trim();
    if (/^cid:/i.test(u)) {
      let id = u.slice(4);
      try {
        id = decodeURIComponent(id);
      } catch {
        // The id stays as written.
      }
      return status(ids.get(id.toLowerCase()));
    }
    return status(locations.get(u) ?? locations.get(norm(u, part.location)));
  };
}

/** The first pass over an MHT file: each markup and CSS part is read here, and every other part goes to the plugins. */
async function analyzeMht(run: Run, src: ByteSource, findings: FindingList): Promise<{ plan: Plan; encoding: string }> {
  const file = await readMht(src, { parts: run.limits.parts, depth: run.limits.xmlDepth, decodedBytes: run.limits.decodedBytes, memoryThreshold: run.threshold, temp: run.temp, check: run.check });
  const leaves = leafParts(file.parts);
  for (const p of leaves) {
    if (!p.body) continue;
    run.sinks.push(p.body);
    if (p.body.spilled) findings.push(run.factory.make(C.Processing, D.MemoryFallback, `part ${p.index}`, { part: `MHT part ${p.index}` }));
  }
  if (!leaves.some(p => p.body)) throw new StopError(C.Mht, D.Malformed, 'No parts', {});
  if (file.hidden) {
    const f = run.factory.make(C.Mht, D.HiddenData, undefined, { bytes: file.hidden });
    if (f.action === 'info') f.action = 'strip';
    findings.push(f);
  }
  const parts = new Map<number, PartPlan>();
  let encoding = '';
  for (const part of leaves) {
    run.check();
    const label = part.name ?? part.location;
    const loc = `part ${part.index}${label ? ` (${label.length > 80 ? `${label.slice(0, 77)}...` : label})` : ''}`;
    const body = part.body;
    if (!body || part.undecodable !== undefined) {
      const f = run.factory.make(C.Embedded, D.NoPlugin, loc, { name: part.name ?? '', reason: 'cannot decode', encoding: part.undecodable ?? '' });
      if (f.action === 'info') f.action = 'strip';
      findings.push(f);
      parts.set(part.index, { kind: 'drop' });
      continue;
    }
    await using(body.source(), async source => {
      const head = await source.read(0, Math.min(body.length, 4096));
      const sniff = sniffMarkup(head);
      const keyPrefix = `p${part.index}:`;
      const isPart = partResolver(file, part, parts);
      if ((sniff && sniff.kind !== 'mht') || MARKUP_TYPES.has(part.type)) {
        const plan = await analyzeMarkup(run, source, findings, { keyPrefix, locPrefix: `${loc}, `, transport: part.params.get('charset'), isPart });
        parts.set(part.index, { kind: 'markup', plan });
        if (!encoding) encoding = plan.encoding;
      } else if (part.type === 'text/css') {
        const enc = encodingFor(part.params.get('charset') ?? 'utf-8') ?? 'utf-8';
        const text = decoderFor(enc).decode(Buffer.from(await source.read(0, body.length)));
        const memo = new Memo();
        const list = new FindingList();
        const ctx = makeCtx(run, list, memo, isPart);
        new Rules(ctx, { html: true, keyPrefix, locPrefix: `${loc}, `, lineOffset: 0 }).sheet(text);
        await drainJobs(run, ctx);
        findings.merge(list);
        parts.set(part.index, { kind: 'css', text, memo, keyPrefix, locPrefix: `${loc}, ` });
      } else {
        const found: DefuseFinding[] = [];
        const r = await decideFile(run, { source, size: body.length, name: part.name ?? lastSegment(part.location), declaredType: part.type, location: loc }, found);
        for (const f of found) findings.push(f);
        parts.set(part.index, { kind: 'file', decision: r.keep ? { keep: true } : { keep: false }, replacement: r.replacement });
      }
    });
  }
  return { plan: { kind: 'mht', file, parts }, encoding };
}

/**
 * Whether the first bytes are binary: a format the type check knows by its signature, or a NUL byte in text that is
 * not UTF-16.
 */
function isBinary(head: Uint8Array): boolean {
  if (sniffType(head.subarray(0, 1024)) !== undefined) return true;
  const bom = bomOf(head);
  return bom?.encoding !== 'utf-16le' && bom?.encoding !== 'utf-16be' && head.includes(0);
}

/** The last path segment of a URL, as a file name for the type check. */
function lastSegment(location: string | undefined): string | undefined {
  if (!location) return undefined;
  const seg = location.split(/[?#]/, 1)[0].split(/[/\\]/).pop();
  return seg || undefined;
}

/** Inspects `source`, and keeps the plan the rewrite follows. It throws an I/O error instead of reporting a verdict. */
async function analyze(run: Run, source: ByteSource, name?: string, mode?: 'xml' | 'html'): Promise<Analysis> {
  const findings = new FindingList();
  let format: XmlFormat = '';
  let encoding = '';
  const src = run.temp.watch(source);
  try {
    const limits = run.limits;
    if (limits.nestingDepth !== undefined && run.depth > limits.nestingDepth) throw new NestingLimitError('Nesting limit exceeded');
    const size = await src.size();
    if (limits.fileSize !== undefined && size > limits.fileSize) throw new StopError(C.Limit, D.FileSize, `${size} bytes`, { size, limit: limits.fileSize });
    run.check();
    if (name !== undefined && extensionOf(name) === 'hta') findings.push(run.factory.make(C.Format, D.Hta, undefined, { name: name.slice(0, 200) }));
    const head = await src.read(0, Math.min(size, 4096));
    const sniff = sniffMarkup(head);
    if (sniff?.kind === 'xml' && isOfficeXml(head)) findings.push(run.factory.make(C.Format, D.Office));
    // Without markup at the start, text is still a page to a browser, which shows it. Binary content is not.
    if (!sniff && mode === undefined && isBinary(head)) throw new StopError(C.Format, D.Unrecognized, 'Binary content, with no markup or MIME headers at the start', {});
    let plan: Plan;
    if (sniff?.kind === 'mht' && mode === undefined) {
      format = 'mht';
      const m = await analyzeMht(run, src, findings);
      plan = m.plan;
      encoding = m.encoding;
    } else {
      const markup = await analyzeMarkup(run, src, findings, { keyPrefix: '', locPrefix: '', mode });
      plan = { kind: 'markup', markup };
      format = markup.format;
      encoding = markup.encoding;
    }
    if (run.temp.ioError !== undefined) throw run.temp.ioError;
    return { inspection: finish(findings.all(), run.options, false, format, encoding, run.verify !== undefined), plan };
  } catch (e) {
    if (run.temp.ioError !== undefined) throw run.temp.ioError;
    if (isIoError(e)) throw e;
    const code = stopsTree(e);
    if (code === 'DEFUSE_IO') throw e;
    if (code === 'DEFUSE_LIMIT' && run.depth > 0) throw e;
    const all = findings.all();
    all.push(stopFinding(run.factory, e));
    return { inspection: finish(all, run.options, true, format, encoding) };
  }
}

/** The finding for an error that stopped the run. */
function stopFinding(factory: FindingFactory, e: unknown): DefuseFinding {
  if (e instanceof StopError) return factory.make(e.category, e.detail, e.location, { ...e.data, reason: String(e.data?.reason ?? e.message).slice(0, 200) });
  if (e instanceof LimitText) return factory.make(C.Limit, D.TokenSize, undefined, { limit: e.limit });
  if (stopsTree(e) === 'DEFUSE_LIMIT') return factory.make(C.Limit, (e as { limit?: unknown }).limit === 'nesting' ? D.NestingDepth : D.Time);
  // Anything unexpected rejects the file rather than escaping as an exception.
  return factory.make(C.Format, D.Unreadable, undefined, { reason: String((e as Error)?.message ?? e).slice(0, 200) });
}

/** The second pass over one markup document, writing what the rules keep. */
async function writeMarkup(run: Run, src: ByteSource, plan: MarkupPlan, sink: ByteSink): Promise<void> {
  const ctx = makeCtx(run, undefined, plan.memo, plan.isPart);
  await readMarkup(run, src, plan, ctx, { buf: new OutputBuffer(), sink });
}

/** A Content-Type for a markup or CSS part the rewrite wrote in UTF-8. */
function utf8Type(part: MhtPart): string {
  const params = new Map(part.params);
  params.set('charset', 'utf-8');
  return contentType(part.type, params);
}

/** Writes the rewrite of the whole file to `out`. */
async function write(run: Run, input: ByteSource, plan: Plan, out: ByteSink): Promise<void> {
  if (plan.kind === 'markup') {
    await writeMarkup(run, input, plan.markup, out);
    return;
  }
  await writeMht(plan.file, out, async (part): Promise<PartOutput> => {
    run.check();
    const p = plan.parts.get(part.index);
    const body = part.body;
    if (!p || p.kind === 'drop' || !body) return undefined;
    if (p.kind === 'markup') {
      const sink = run.spill();
      await using(body.source(), s => writeMarkup(run, s, p.plan, sink));
      await sink.close();
      return { source: sink.source(), contentType: utf8Type(part) };
    }
    if (p.kind === 'css') {
      const ctx = makeCtx(run, undefined, p.memo);
      const css = new Rules(ctx, { html: true, keyPrefix: p.keyPrefix, locPrefix: p.locPrefix, lineOffset: 0 }).sheet(p.text);
      return { source: bufferSource(Buffer.from(css, 'utf8')), contentType: utf8Type(part) };
    }
    if (!p.decision.keep) return undefined;
    return { source: p.replacement ? p.replacement.source() : body.source(), contentType: contentType(part.type, part.params) };
  });
}

/**
 * Reads the output in the syntax its own reading does not use: an XML output as HTML, and an HTML output as XML up to
 * the first error, as a browser that shows a page as far as it parsed. An MHT output is read whole as HTML. Returns
 * the findings that reading makes.
 */
async function crossRead(run: Run, src: ByteSource, plan: Plan): Promise<DefuseFinding[]> {
  const findings = new FindingList();
  const memo = new Memo();
  const ctx = makeCtx(run, findings, memo);
  const html = plan.kind === 'mht' || plan.markup.mode === 'xml';
  const size = await src.size();
  const head = await src.read(0, Math.min(size, CHUNK));
  const enc = htmlEncoding(head, undefined, head.length === size);
  const p: MarkupPlan = { mode: html ? 'html' : 'xml', encoding: enc.encoding, bom: enc.bom, memo, keyPrefix: 'x:', locPrefix: '', format: html ? 'html' : 'xml' };
  try {
    const rules = await readMarkup(run, src, p, ctx);
    finishDocument(run, ctx, rules, '');
  } catch (e) {
    // An XML reader stops at its first error, or at one of its limits, and shows what came before.
    if (html || !(e instanceof StopError || e instanceof LimitText) || (e instanceof StopError && e.category !== C.Xml && e.category !== C.Limit)) throw e;
  }
  return findings.all();
}

async function closeSource(source: ByteSource): Promise<void> {
  try {
    await source.close?.();
  } catch {
    // The verdict stands whether or not the source closes.
  }
}

/** Copies to the caller's sink. On failure it aborts the sink instead of closing it, so a partial copy does not look whole. */
async function deliver(from: ByteSource, sink: ByteSink): Promise<void> {
  try {
    await copyToSink(from, sink);
  } catch (e) {
    try {
      await sink.abort?.(e);
    } catch {
      // The copy's error is the one to report.
    }
    throw e;
  }
  await sink.close();
}

const deadlineFor = (options: XmlOptions) => (options.limits?.timeMs !== undefined ? Date.now() + options.limits.timeMs : undefined);

/** Inspects a file without changing it. The source is closed when the run ends. */
export async function inspectXmlSource(source: ByteSource, options: XmlOptions = {}): Promise<XmlInspection> {
  return inspectAtDepth(source, options, 0, deadlineFor(options), options.name);
}

/** Internal entry that carries the depth, the deadline and the file's name. */
export async function inspectAtDepth(source: ByteSource, options: XmlOptions, depth: number, deadline: number | undefined, name?: string): Promise<XmlInspection> {
  const run = new Run(options, depth, deadline);
  try {
    return (await analyze(run, source, name)).inspection;
  } finally {
    if (depth === 0) await closeSource(source);
    await run.cleanup();
  }
}

/**
 * Writes a defused copy of `source` to `sink`. Nothing reaches the sink unless the output passes inspection in its own
 * syntax and in the other one. The source is closed when the run ends.
 */
export async function disarmXmlSource(source: ByteSource, sink: ByteSink, options: XmlOptions = {}): Promise<XmlDisarmResult> {
  return disarmAtDepth(source, sink, options, 0, deadlineFor(options), options.name);
}

/** Internal entry that carries the nesting depth, the deadline a nested file shares with the upload, and its name. */
export async function disarmAtDepth(source: ByteSource, sink: ByteSink, options: XmlOptions, depth: number, deadline: number | undefined, name?: string): Promise<XmlDisarmResult> {
  const run = new Run(options, depth, deadline);
  let input = source;
  try {
    let a: Analysis;
    try {
      // A caller's source can change between reads, so both passes read one snapshot. A nested file's source belongs
      // to the engine that found it, and analysis rejects a file over the size limit unread.
      const fileSize = run.limits.fileSize;
      if (depth === 0 && (fileSize === undefined || (await source.size()) <= fileSize)) {
        const snapshot = run.spill();
        try {
          await copyToSink(source, snapshot, run.check);
        } finally {
          await snapshot.close();
        }
        input = snapshot.source();
      }
      a = await analyze(run, input, name);
    } catch (e) {
      if (stopsTree(e) !== 'DEFUSE_LIMIT' || depth > 0) throw e;
      a = { inspection: finish([stopFinding(run.factory, e)], options, true, '', '') };
    }
    const before = a.inspection;
    const plan = a.plan;
    if (before.status === 'rejected' || !plan) return { status: 'rejected', before, removed: [] };
    const out = run.spill();
    try {
      await write(run, input, plan, out);
    } catch (e) {
      await out.close().catch(() => undefined);
      if (run.temp.ioError !== undefined) throw run.temp.ioError;
      if (isIoError(e) || stopsTree(e) === 'DEFUSE_IO') throw e;
      if (stopsTree(e) === 'DEFUSE_LIMIT' && depth > 0) throw e;
      const f = e instanceof StopError || e instanceof LimitText || stopsTree(e) === 'DEFUSE_LIMIT' ? stopFinding(run.factory, e) : undefined;
      before.findings.push(f ?? run.factory.make(C.Processing, D.VerificationFailed, undefined, { reasons: `write failed: ${String((e as Error)?.message ?? e).slice(0, 100)}` }));
      before.status = 'rejected';
      if (f) {
        before.score = null;
        before.risk = XmlRisk.Unknown;
      }
      return { status: 'rejected', before, removed: [] };
    }
    await out.close();
    if (run.temp.ioError !== undefined) throw run.temp.ioError;
    const verifyOptions: XmlOptions = {
      actionOverrides: options.actionOverrides,
      scoreWeights: options.scoreWeights,
      scoreBands: options.scoreBands,
      tempDir: options.tempDir,
      memoryThreshold: options.memoryThreshold,
      limits: { ...options.limits, fileSize: undefined, nestingDepth: undefined },
    };
    const check = new Run(verifyOptions, depth, deadline, run.kept);
    let after: XmlInspection;
    let cross: DefuseFinding[];
    try {
      after = (await using(out.source(), s => analyze(check, s, undefined, plan.kind === 'markup' ? plan.markup.mode : undefined))).inspection;
      try {
        cross = await using(out.source(), s => crossRead(check, s, plan));
      } catch (e) {
        if (!(e instanceof StopError || e instanceof LimitText)) throw e;
        cross = [stopFinding(check.factory, e)];
      }
    } finally {
      await check.cleanup();
    }
    const reasons = after.findings.filter(f => f.action !== 'info').map(f => `${f.category}/${f.detail}`);
    // A check that stopped early verified nothing, even when the caller overrode the finding that stopped it to info.
    if (after.status === 'rejected' && !reasons.length) reasons.push('the output check stopped early');
    for (const f of cross) if (f.action !== 'info') reasons.push(`${f.category}/${f.detail} when read as ${plan.kind === 'markup' && plan.markup.mode === 'html' ? 'XML' : 'HTML'}`);
    if (reasons.length) {
      before.findings.push(run.factory.make(C.Processing, D.VerificationFailed, undefined, { reasons: [...new Set(reasons)].slice(0, 10).join(', ') }));
      before.status = 'rejected';
      return { status: 'rejected', before, removed: [] };
    }
    after.format = before.format;
    after.mimeType = before.mimeType;
    await using(out.source(), s => deliver(s, sink));
    return { status: before.status === 'clean' ? 'clean' : 'defused', before, after, removed: before.findings.filter(f => f.action === 'strip') };
  } catch (e) {
    // A nested file's I/O error fails the upload's run too, instead of counting as a failed plugin.
    if (depth > 0 && (isIoError(e) || (e !== undefined && e === run.temp.ioError))) throw new NestedIoError(e);
    throw e;
  } finally {
    if (input !== source) await closeSource(input);
    if (depth === 0) await closeSource(source);
    await run.cleanup();
  }
}

/** Inspects bytes. */
export async function inspectXml(bytes: Uint8Array, options: XmlOptions = {}): Promise<XmlInspection> {
  return inspectXmlSource(bufferSource(bytes), options);
}

/** Defuses bytes. `bytes` holds the output unless the file was rejected. */
export async function disarmXml(bytes: Uint8Array, options: XmlOptions = {}): Promise<XmlDisarmResult & { bytes?: Uint8Array }> {
  const sink = bufferSink();
  const result = await disarmXmlSource(bufferSource(bytes), sink, options);
  return result.status === 'rejected' ? result : { ...result, bytes: sink.result() };
}
