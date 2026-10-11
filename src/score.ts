import { findingSpec } from './findings';
import { XmlCategory as C, XmlDetail as D, type DefuseFinding, type XmlOptions, XmlRisk, type XmlScoreBands } from './types';

export const DEFAULT_BANDS: XmlScoreBands = { low: 1, medium: 25, high: 50, critical: 80 };

interface Combination {
  name: string;
  weight: number;
  test(has: (c: C, d?: D) => boolean): boolean;
}

/** An embedded plugin, applet or ActiveX control. */
const embedsCode = (has: (c: C, d?: D) => boolean) => has(C.Embedded, D.Object) || has(C.Embedded, D.Embed) || has(C.Embedded, D.Applet);

export const COMBINATIONS: Combination[] = [
  { name: 'a password field with a form that sends data', weight: 20, test: has => has(C.Form, D.Password) && has(C.Form, D.Submit) },
  { name: 'script with an object, embed or applet', weight: 15, test: has => has(C.Script) && embedsCode(has) },
  {
    name: 'script with obfuscated style, encoding or comments',
    weight: 15,
    test: has => has(C.Script) && (has(C.Style, D.Escaped) || has(C.Format, D.Utf7) || has(C.Format, D.ConditionalComment)),
  },
  { name: 'script with a form that sends data or a redirect', weight: 10, test: has => has(C.Script) && (has(C.Form, D.Submit) || has(C.Navigation, D.Refresh)) },
];

/** The caller's weights first, then the built-in table. A kind from another package scores at the weight it carries. */
export function weightOf(f: DefuseFinding, options: XmlOptions): number {
  const w = options.scoreWeights ?? [];
  const exact = w.find(x => x.category === f.category && x.detail === f.detail);
  if (exact) return exact.weight;
  const cat = w.find(x => x.category === f.category && x.detail === undefined);
  if (cat) return cat.weight;
  return findingSpec(f.category, f.detail)?.weight ?? f.weight ?? 0;
}

/** Highest weight in full, a quarter of each other kind's weight, plus combinations, capped at 100. */
export function scoreFindings(findings: DefuseFinding[], options: XmlOptions): { score: number; risk: XmlRisk } {
  // Each kind of finding counts once, so twenty links of one kind do not add up to a critical file.
  const byKind = new Map<string, number>();
  for (const f of findings) {
    const k = `${f.category}/${f.detail}`;
    byKind.set(k, Math.max(byKind.get(k) ?? 0, weightOf(f, options)));
  }
  const weights = [...byKind.values()].sort((a, b) => b - a);
  let score = weights.length ? weights[0] + weights.slice(1).reduce((s, w) => s + w / 4, 0) : 0;
  const has = (c: C, d?: D) => findings.some(f => f.category === c && (d === undefined || f.detail === d) && weightOf(f, options) > 0);
  for (const combo of COMBINATIONS) if (combo.test(has)) score += combo.weight;
  score = Math.min(100, Math.round(score));
  return { score, risk: riskFor(score, options.scoreBands ?? DEFAULT_BANDS) };
}

export function riskFor(score: number, bands: XmlScoreBands): XmlRisk {
  if (score >= bands.critical) return XmlRisk.Critical;
  if (score >= bands.high) return XmlRisk.High;
  if (score >= bands.medium) return XmlRisk.Medium;
  if (score >= bands.low) return XmlRisk.Low;
  return XmlRisk.None;
}
