import { expect } from 'chai';
import { StopError } from '../src/errors';
import { ContentState, type HtmlAttribute, type HtmlDoctype, HtmlTokenizer, type HtmlTokenSink } from '../src/html';
import { NS } from '../src/markup';
import { HtmlTree, type MarkupDoctype, type MarkupHandler } from '../src/tree';

/** Records tokenizer events as short strings. Text pieces next to each other are joined. */
class Tokens implements HtmlTokenSink {
  readonly out: string[] = [];
  state?: ContentState;
  inForeign = false;
  tokenizer?: HtmlTokenizer;
  private push(s: string): void {
    this.out.push(s);
  }
  start(name: string, attrs: HtmlAttribute[], selfClosing: boolean, line: number): void {
    this.push(`<${name}${attrs.map(a => ` ${a.name}=${JSON.stringify(a.value)}`).join('')}${selfClosing ? '/' : ''}>@${line}`);
    if (this.state !== undefined && ['style', 'script', 'textarea', 'xmp', 'plaintext', 'title'].includes(name)) this.tokenizer?.setState(this.state);
  }
  end(name: string, line: number): void {
    this.push(`</${name}>@${line}`);
  }
  text(text: string): void {
    const last = this.out.length - 1;
    if (last >= 0 && this.out[last].startsWith('"')) this.out[last] = JSON.stringify(JSON.parse(this.out[last]) + text);
    else this.push(JSON.stringify(text));
  }
  comment(text: string, line: number, bogus: boolean): void {
    this.push(`${bogus ? 'bogus' : 'comment'}(${text})@${line}`);
  }
  doctype(d: HtmlDoctype, line: number): void {
    this.push(`doctype(${d.name ?? ''}|${d.publicId ?? '-'}|${d.systemId ?? '-'}|${d.forceQuirks ? 'quirks' : 'ok'})@${line}`);
  }
  serverTag(line: number): void {
    this.push(`server@${line}`);
  }
  foreign(): boolean {
    return this.inForeign;
  }
}

/** The events of `input` fed in pieces of `piece` characters. `raw` is the state the tokenizer enters after a raw text start tag. */
function tokens(input: string, piece = 1 << 20, raw?: ContentState, foreign = false): string[] {
  const sink = new Tokens();
  sink.state = raw;
  sink.inForeign = foreign;
  const t = new HtmlTokenizer(sink, 1 << 20);
  sink.tokenizer = t;
  for (let i = 0; i < input.length; i += piece) t.write(input.slice(i, i + piece));
  t.end();
  return sink.out;
}

/** Records what the tree hands the rules: each element with its namespace, and whether an end tag closed it. */
class Elements implements MarkupHandler {
  readonly out: string[] = [];
  start(el: Parameters<MarkupHandler['start']>[0]): void {
    const ns = el.ns === NS.html ? '' : el.ns === NS.svg ? 'svg:' : el.ns === NS.mathml ? 'math:' : `${el.ns}:`;
    const attrs = el.attributes.map(a => ` ${a.ns === NS.xlink ? 'xlink:' : a.ns === NS.xml ? 'xml:' : ''}${a.local}=${a.value}`).join('');
    this.out.push(`<${ns}${el.qname}${attrs}>`);
  }
  end(el: Parameters<MarkupHandler['end']>[0], explicit: boolean): void {
    this.out.push(`</${el.qname}${explicit ? '' : '?'}>`);
  }
  strayEnd(qname: string): void {
    this.out.push(`stray</${qname}>`);
  }
  text(text: string): void {
    const last = this.out.length - 1;
    if (last >= 0 && this.out[last].startsWith('"')) this.out[last] = JSON.stringify(JSON.parse(this.out[last]) + text);
    else this.out.push(JSON.stringify(text));
  }
  comment(text: string): void {
    this.out.push(`<!--${text}-->`);
  }
  instruction(): void {
    // HTML has none.
  }
  doctype(d: MarkupDoctype): void {
    this.out.push(`doctype ${d.name}`);
  }
  serverCode(): void {
    this.out.push('server');
  }
}

function tree(input: string, depth = 4096): string[] {
  const handler = new Elements();
  const t = new HtmlTree(handler, depth);
  const tokenizer = new HtmlTokenizer(t, 1 << 20);
  t.attach(tokenizer);
  tokenizer.write(input);
  tokenizer.end();
  t.finish();
  return handler.out;
}

describe('HTML tokenizer', () => {
  it('reads tags and attributes, lowercasing names and dropping a repeated attribute', () => {
    expect(tokens('<DIV Class=a ID="b" data-x=\'c\' class="d" =e checked>x</DIV>')).to.deep.equal(['<div class="a" id="b" data-x="c" =e="" checked="">@1', '"x"', '</div>@1']);
    expect(tokens('<br/><img src=x/><a href=y /></b x>')).to.deep.equal(['<br/>@1', '<img src="x/">@1', '<a href="y"/>@1', '</b>@1']);
  });

  it('decodes character references as the standard says, in text and in attribute values', () => {
    expect(tokens('&amp &lt;x&gt; &copy1 &notit; &#x80;&#150;&#0;&#xD800;&#x110000; &bogus; &#;')).to.deep.equal(['"& <x> \u00a91 \u00acit; \u20AC\u2013\uFFFD\uFFFD\uFFFD &bogus; &#;"']);
    // In a value, a legacy name followed by "=" or a letter stays as written.
    expect(tokens('<a href="?a=1&copy=2&copy;&notit;&amp">')).to.deep.equal(['<a href="?a=1&copy=2\u00a9&notit;&">@1']);
  });

  it('normalizes line ends and counts lines across pieces', () => {
    expect(tokens('a\r\nb\rc\n<p>', 1)).to.deep.equal(['"a\\nb\\nc\\n"', '<p>@4']);
    expect(tokens('a\r', 2).concat(tokens('\nb'))).to.deep.equal(['"a\\n"', '"\\nb"']);
  });

  it('reads comments as the comment states do, abrupt and odd endings included', () => {
    expect(tokens('<!-- a --><!--><!---><!-- b --!><!-- c -- d --><!--<!-- e -->')).to.deep.equal([
      'comment( a )@1',
      'comment()@1',
      'comment()@1',
      'comment( b )@1',
      'comment( c -- d )@1',
      'comment(<!-- e )@1',
    ]);
    expect(tokens('<!-- open')).to.deep.equal(['comment( open)@1']);
  });

  it('reads processing instructions, odd declarations and bad end tags as bogus comments, and "<%" as text', () => {
    expect(tokens('<?php x ?></ x><!x><![CDATA[y]]><% z %>')).to.deep.equal(['bogus(?php x ?)@1', 'bogus( x)@1', 'bogus(x)@1', 'bogus([CDATA[y]])@1', 'server@1', '"<% z %>"']);
  });

  it('reads CDATA sections only in foreign content', () => {
    expect(tokens('<![CDATA[a<b>]]]>c', 1 << 20, undefined, true)).to.deep.equal(['"a<b>]c"']);
  });

  it('reads document type declarations, with their identifiers and quirks', () => {
    expect(tokens('<!DOCTYPE html>')).to.deep.equal(['doctype(html|-|-|ok)@1']);
    expect(tokens('<!doctype HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" \'http://www.w3.org/TR/html4/strict.dtd\'>')).to.deep.equal([
      'doctype(html|-//W3C//DTD HTML 4.01//EN|http://www.w3.org/TR/html4/strict.dtd|ok)@1',
    ]);
    expect(tokens('<!DOCTYPE svg [<!ENTITY x "y">]>z')).to.deep.equal(['doctype(svg|-|-|quirks)@1', '"]>z"']);
    expect(tokens('<!DOCTYPE>')).to.deep.equal(['doctype(|-|-|quirks)@1']);
  });

  it('ends raw text only at the end tag of the element that started it', () => {
    expect(tokens('<style>a</b><p></style >x', 1 << 20, ContentState.Rawtext)).to.deep.equal(['<style>@1', '"a</b><p>"', '</style>@1', '"x"']);
    expect(tokens('<title>&amp;<b></title>', 1 << 20, ContentState.Rcdata)).to.deep.equal(['<title>@1', '"&<b>"', '</title>@1']);
    expect(tokens('<plaintext></plaintext><b>', 1 << 20, ContentState.Plaintext)).to.deep.equal(['<plaintext>@1', '"</plaintext><b>"']);
  });

  it('follows the script data escape states, where </script> inside <!-- <script> does not end the script', () => {
    const input = '<script><!-- <script> x </script> y --></script>z';
    expect(tokens(input, 1 << 20, ContentState.ScriptData)).to.deep.equal(['<script>@1', '"<!-- <script> x </script> y -->"', '</script>@1', '"z"']);
    expect(tokens('<script><!-- x </script>z', 1 << 20, ContentState.ScriptData)).to.deep.equal(['<script>@1', '"<!-- x "', '</script>@1', '"z"']);
  });

  it('gives the same tokens however the text is split', () => {
    const input = '<!DOCTYPE html><p class="a&amp;b" id=c>t&eacute;xt &notin x</p><!-- c --!><script><!-- <script></script> --></script><?pi?><a href=\'&#x6a;avascript:x\'>&lt;</a>\r\n<br/>';
    const whole = tokens(input, 1 << 20, ContentState.ScriptData);
    for (const piece of [1, 2, 3, 7]) expect(tokens(input, piece, ContentState.ScriptData), `pieces of ${piece}`).to.deep.equal(whole);
  });

  it('drops a tag the file ends inside, as the end of the file does', () => {
    expect(tokens('<p>x<img src="a')).to.deep.equal(['<p>@1', '"x"']);
    expect(tokens('x</')).to.deep.equal(['"x</"']);
  });

  it('limits the characters of one tag, comment or declaration', () => {
    const sink = new Tokens();
    const t = new HtmlTokenizer(sink, 20);
    expect(() => t.write(`<p title="${'x'.repeat(30)}">`)).to.throw(StopError, 'longer than 20');
    const t2 = new HtmlTokenizer(new Tokens(), 20);
    t2.write(`${'x'.repeat(100)}<p>`);
    t2.end();
  });
});

describe('HTML tree', () => {
  it('puts SVG and MathML elements in their namespaces, with their names and attributes adjusted', () => {
    expect(tree('<svg viewbox="0 0 1 1" xlink:href="#a" xml:lang="en"><lineargradient gradientunits="x"/><foreignobject/></svg><math definitionurl="u"><mi>x</mi></math>')).to.deep.equal([
      '<svg:svg viewBox=0 0 1 1 xlink:href=#a xml:lang=en>',
      '<svg:linearGradient gradientUnits=x>',
      '</linearGradient>',
      '<svg:foreignObject>',
      '</foreignObject>',
      '</svg>',
      '<math:math definitionURL=u>',
      '<math:mi>',
      '"x"',
      '</mi>',
      '</math>',
    ]);
  });

  it('leaves foreign content at a tag HTML takes back, and at a font element with a presentation attribute', () => {
    expect(tree('<svg><g><p>x</p></g></svg>')).to.deep.equal(['<svg:svg>', '<svg:g>', '</g?>', '</svg?>', '<p>', '"x"', '</p>', 'stray</g>', 'stray</svg>']);
    expect(tree('<svg><font color=red>a</font><font>b</font></svg>')).to.deep.equal(['<svg:svg>', '</svg?>', '<font color=red>', '"a"', '</font>', '<font>', '"b"', '</font>', 'stray</svg>']);
    expect(tree('<svg><style><img src=x onerror=y></style></svg>')).to.deep.equal([
      '<svg:svg>',
      '<svg:style>',
      '</style?>',
      '</svg?>',
      '<img src=x onerror=y>',
      '</img?>',
      'stray</style>',
      'stray</svg>',
    ]);
  });

  it('reads HTML at the integration points of SVG and MathML', () => {
    expect(tree('<svg><desc><style><b>x</b></style></desc></svg>')).to.deep.equal(['<svg:svg>', '<svg:desc>', '<style>', '"<b>x</b>"', '</style>', '</desc>', '</svg>']);
    expect(tree('<math><mtext><style><b></style></mtext><annotation-xml encoding="text/html"><p>a</p></annotation-xml></math>')).to.deep.equal([
      '<math:math>',
      '<math:mtext>',
      '<style>',
      '"<b>"',
      '</style>',
      '</mtext>',
      '<math:annotation-xml encoding=text/html>',
      '<p>',
      '"a"',
      '</p>',
      '</annotation-xml>',
      '</math>',
    ]);
    // An mglyph in a MathML text integration point stays MathML.
    expect(tree('<math><mi><mglyph><style><b>x</b>')).to.deep.equal([
      '<math:math>',
      '<math:mi>',
      '<math:mglyph>',
      '<math:style>',
      '</style?>',
      '</mglyph?>',
      '<b>',
      '"x"',
      '</b>',
      '</mi?>',
      '</math?>',
    ]);
  });

  it('implies the end tags the common start tags imply', () => {
    expect(tree('<p>a<div>b</div><ul><li>c<li>d</ul><dl><dt>e<dd>f</dl><table><tr><td>g<td>h<tr><td>i</table><select><option>j<option>k</select>')).to.deep.equal([
      '<p>',
      '"a"',
      '</p?>',
      '<div>',
      '"b"',
      '</div>',
      '<ul>',
      '<li>',
      '"c"',
      '</li?>',
      '<li>',
      '"d"',
      '</li?>',
      '</ul>',
      '<dl>',
      '<dt>',
      '"e"',
      '</dt?>',
      '<dd>',
      '"f"',
      '</dd?>',
      '</dl>',
      '<table>',
      '<tr>',
      '<td>',
      '"g"',
      '</td?>',
      '<td>',
      '"h"',
      '</td?>',
      '</tr?>',
      '<tr>',
      '<td>',
      '"i"',
      // The table end tag closes the cell and the row left open, as the table insertion modes do.
      '</td?>',
      '</tr?>',
      '</table>',
      '<select>',
      '<option>',
      '"j"',
      '</option?>',
      '<option>',
      '"k"',
      '</option?>',
      '</select>',
    ]);
  });

  it('closes an open a, nobr or button at another, and a select at an input', () => {
    expect(tree('<a>1<a>2</a><button>3<button>4</button><select><input>')).to.deep.equal([
      '<a>',
      '"1"',
      '</a?>',
      '<a>',
      '"2"',
      '</a>',
      '<button>',
      '"3"',
      '</button?>',
      '<button>',
      '"4"',
      '</button>',
      '<select>',
      '</select?>',
      '<input>',
      '</input?>',
    ]);
  });

  it('reports end tags that close nothing, and leaves a form end tag to the form alone', () => {
    expect(tree('</p></br></body><form><div></form>x</div>')).to.deep.equal(['stray</p>', 'stray</br>', 'stray</body>', '<form>', '<div>', '</form>', '"x"', '</div>']);
  });

  it('switches the tokenizer to raw text after the elements that hold it, in HTML only', () => {
    expect(tree('<textarea><b></textarea><noscript><i></noscript><iframe><u></iframe>')).to.deep.equal([
      '<textarea>',
      '"<b>"',
      '</textarea>',
      '<noscript>',
      '"<i>"',
      '</noscript>',
      '<iframe>',
      '"<u>"',
      '</iframe>',
    ]);
    // Read as a browser with scripting off, a noscript element holds markup.
    const off = new Elements();
    const t = new HtmlTree(off, 100, false);
    const tokenizer = new HtmlTokenizer(t, 1 << 20);
    t.attach(tokenizer);
    tokenizer.write('<noscript><i>x</i></noscript>');
    tokenizer.end();
    t.finish();
    expect(off.out).to.deep.equal(['<noscript>', '<i>', '"x"', '</i>', '</noscript>']);
  });

  it('renames image to img, and merges a second html, head or body into the first', () => {
    expect(tree('<body><image src=a><body class=x>')).to.deep.equal(['<body>', '<img src=a>', '</img?>', '<body class=x>', '</body?>', '</body?>']);
  });

  it('closes the cells and rows a table leaves open at its end tag, so many such tables do not pile up depth', () => {
    expect(tree('<table><tr><td>a<td>b</table>'.repeat(3000), 10).filter(e => e === '</table>').length).to.equal(3000);
  });

  it('limits element depth', () => {
    expect(() => tree('<div>'.repeat(11), 10)).to.throw(StopError, 'deeper than 10');
    expect(tree('<div>'.repeat(10), 10).length).to.equal(20);
  });
});
