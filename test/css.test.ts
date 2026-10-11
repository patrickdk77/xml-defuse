import { expect } from 'chai';
import { type CssUrlDecision, escapeMarkupInCss, filterCss } from '../src/css';
import type { XmlCategory as C, XmlDetail as D, XmlFindingAction } from '../src/types';

/** Runs filterCss with every finding stripped, URLs decided by `decide`, and records what it reported. */
function filter(css: string, decide: (url: string) => CssUrlDecision = () => 'keep', actions: Partial<Record<string, XmlFindingAction>> = {}) {
  const reports: string[] = [];
  const urls: string[] = [];
  const out = filterCss(css, {
    report: (c: C, d: D) => {
      reports.push(`${c}/${d}`);
      return actions[`${c}/${d}`] ?? 'strip';
    },
    url: target => {
      urls.push(target);
      return decide(target);
    },
  });
  return { out, reports, urls };
}

describe('CSS', () => {
  it('drops a declaration with expression(), however escapes, comments and wide letters write it', () => {
    for (const css of ['width: expression(alert(1))', 'width: \\65 xpression(alert(1))', 'width: ex/**/pression(alert(1))', 'width: EXPRESSION (1)', 'width: \uFF45xpression(1)']) {
      const r = filter(`a { color: red; ${css}; top: 0 }`);
      expect({ out: r.out, reports: r.reports.filter(k => k !== 'STYLE/ESCAPED') }, css).to.deep.equal({ out: 'a { color: red;  top: 0 }', reports: ['STYLE/EXPRESSION'] });
    }
  });

  it('drops bindings: behavior, -moz-binding and ActiveX filters, by property name even when escaped', () => {
    expect(filter('a { behavior: url(x.htc); color: red }').out).to.equal('a {  color: red }');
    expect(filter('a { -moz-binding: url(x.xml#b) }').reports).to.deep.equal(['STYLE/BINDING']);
    expect(filter('a { \\62 ehavior: url(x) }').reports).to.deep.equal(['STYLE/ESCAPED', 'STYLE/BINDING']);
    expect(filter('a { filter: progid:DXImageTransform.Microsoft.Alpha(opacity=50) }').reports).to.deep.equal(['STYLE/BINDING']);
  });

  it('reports @import of a style sheet from elsewhere with its target, keeps one beside the page, and drops either when its URL says so', () => {
    const remote = 'https://example.net/a.css';
    expect(filter(`@import url("${remote}") screen; p { color: red }`)).to.deep.equal({ out: ' p { color: red }', reports: ['STYLE/IMPORT'], urls: [remote] });
    expect(filter(`@import "${remote}"; p { x: y }`, () => 'drop', { 'STYLE/IMPORT': 'info' })).to.deep.equal({ out: ' p { x: y }', reports: ['STYLE/IMPORT'], urls: [remote] });
    expect(filter(`@import "${remote}"; p { x: y }`, () => 'keep', { 'STYLE/IMPORT': 'info' }).out).to.equal(`@import "${remote}"; p { x: y }`);
    expect(filter('@import url("a.css") screen; p { color: red }')).to.deep.equal({ out: '@import url("a.css") screen; p { color: red }', reports: [], urls: ['a.css'] });
    expect(filter('@import "b.css"; p { x: y }', () => 'drop')).to.deep.equal({ out: ' p { x: y }', reports: [], urls: ['b.css'] });
  });

  it('checks every URL a declaration loads, in url() and in the functions that take URLs as strings', () => {
    const r = filter('a { background: url(a.png), image-set("b.png" 1x, url(c.png) 2x); cursor: url( "d.cur" ), auto; content: "e.png" }');
    expect(r.urls).to.deep.equal(['a.png', 'b.png', 'c.png', 'd.cur']);
  });

  it('drops a declaration whose URL a rule drops, and rewrites a URL a plugin replaced', () => {
    const r = filter('a { background: url(x.png); color: red } b { list-style: url("y.png") }', u => (u === 'x.png' ? 'drop' : { replace: 'data:image/png;base64,AA==' }));
    expect(r.out).to.equal('a {  color: red } b { list-style: url("data:image/png;base64,AA==") }');
  });

  it('checks the target of a url() a browser drops as malformed, which an older reader may still load', () => {
    const r = filter('a { background: url(javascript:alert(1)); color: red }', u => (/^javascript:/.test(u) ? 'drop' : 'keep'));
    expect(r).to.deep.equal({ out: 'a {  color: red }', reports: [], urls: ['javascript:alert(1'] });
  });

  it('walks nested rules and at-rule blocks, however deep, and leaves selectors alone', () => {
    const r = filter(`@media print { @supports (x: y) { a[href^="javascript:"] { width: expression(1) } } } ${'b{'.repeat(10000)}c: d${'}'.repeat(10000)}`);
    expect(r.reports).to.deep.equal(['STYLE/EXPRESSION']);
    expect(r.out.startsWith('@media print { @supports (x: y) { a[href^="javascript:"] { } } }')).to.equal(true);
  });

  it('reads a style attribute as declarations without a rule around them', () => {
    expect(filter('color: red; width: expression(1)').out).to.equal('color: red; ');
  });

  it('keeps text it does not change exactly as written', () => {
    const css = '/* c */\n@charset "utf-8";\n.a > .b::after { content: "\\201C"; color: #fff !important }\n@font-face { font-family: x; src: local(x) }\n';
    expect(filter(css).out).to.equal(css);
  });

  it('escapes a "<" that would start markup for another reader', () => {
    expect(escapeMarkupInCss('a::before { content: "<b>" } a < b { } </style>')).to.equal('a::before { content: "\\3c b>" } a < b { } \\3c /style>');
  });
});
