import { disarmAtDepth, RUN_OPTIONS, type RunContext } from './engine';
import { weightOf } from './score';
import { extensionOf, isOfficeXml, sniffMarkup, typeFromName } from './sniff';
import type { ContainedFilePlugin, XmlOptions } from './types';

/**
 * Keeps contained files unchanged by type or by name, as pdf-defuse's passThrough does. An entry with a "/" is a MIME
 * type. Any other entry, such as ".png" or "png", is a file name extension.
 */
export function passThrough(types: string[]): ContainedFilePlugin {
  const set = new Set(types.filter(t => t.includes('/')).map(t => t.toLowerCase()));
  const exts = new Set(types.filter(t => !t.includes('/')).map(t => t.trim().toLowerCase().replace(/^\./, '')));
  return {
    kind: 'file',
    name: `passThrough(${types.join(',')})`,
    // Matches on type alone. Whether the content, the declared type and the name agree is the type check's finding.
    accepts: f => {
      const ext = extensionOf(f.name);
      if (ext !== undefined && exts.has(ext)) return true;
      return [f.sniffedType, f.declaredType, typeFromName(f.name)].some(t => t !== undefined && set.has(t.toLowerCase().split(';')[0].trim()));
    },
    process: async () => 'passed',
  };
}

/**
 * Defuses HTML, XML, SVG, XSLT and MHT files inside other files, with `options` when given. Without them, it takes the
 * options of the xml-defuse run that found the file, or none when another package found it. It accepts a file by its
 * content, whatever its name says, except an Office document saved as XML, and rejects one whose name ends in .hta. `limits.nestingDepth` applies to the depth
 * in the context. The file's findings go into the containing file's report, and its output's findings into the
 * output's report, each with its `weight`.
 */
export function xmlPlugin(options?: XmlOptions): ContainedFilePlugin {
  return {
    kind: 'file',
    name: 'xml',
    async accepts(f) {
      const head = await f.source.read(0, Math.min(f.size, 4096));
      // An Office document saved as XML goes to office-defuse.
      return sniffMarkup(head) !== undefined && !isOfficeXml(head);
    },
    async process(file, sink, context) {
      const run = options ?? (context as RunContext)[RUN_OPTIONS] ?? {};
      const r = await disarmAtDepth(file.source, sink, run, context.depth, context.deadline, file.name);
      // A container in another package scores these by the weights this run used.
      for (const f of [...r.before.findings, ...(r.after?.findings ?? [])]) f.weight = weightOf(f, run);
      const findings = r.before.findings;
      if (r.status === 'clean') return { result: 'passed', findings, outputFindings: r.after?.findings };
      if (r.status === 'defused') return { result: 'scrubbed', findings, outputFindings: r.after?.findings };
      return { result: 'removed', findings };
    },
  };
}
