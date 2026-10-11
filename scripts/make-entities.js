// Writes src/entities.ts from the WHATWG HTML Standard's table of named character references.
// Usage: node scripts/make-entities.js <entities.json from https://html.spec.whatwg.org/entities.json>
const fs = require('node:fs');
const path = require('node:path');

const table = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const entries = Object.keys(table)
  .sort()
  .map(k => `${k.slice(1)}:${table[k].codepoints.map(c => c.toString(16)).join('.')}`);
const lines = [];
let line = '';
for (const e of entries) {
  if (line.length + e.length + 1 > 150) {
    lines.push(line);
    line = '';
  }
  line += (line ? ' ' : '') + e;
}
if (line) lines.push(line);
const body = `// The named character references of the WHATWG HTML Standard, https://html.spec.whatwg.org/entities.json, written
// by scripts/make-entities.js. Each entry is the name, with its semicolon where the table has one, a colon, and the
// code points in hex separated by dots.
const DATA = [
${lines.map(l => `  '${l} ',`).join('\n')}
].join('');

/** Each name the table lists, semicolon included where it has one, and the text it stands for. */
export const NAMED_REFERENCES = new Map<string, string>();
for (const entry of DATA.trim().split(' ')) {
  const colon = entry.indexOf(':');
  NAMED_REFERENCES.set(entry.slice(0, colon), String.fromCodePoint(...entry.slice(colon + 1).split('.').map(h => Number.parseInt(h, 16))));
}

/** The length of the longest name, semicolon included. */
export const LONGEST_REFERENCE = ${Math.max(...Object.keys(table).map(k => k.length - 1))};
`;
fs.writeFileSync(path.join(__dirname, '..', 'src', 'entities.ts'), body);
console.log(`src/entities.ts: ${entries.length} references`);
