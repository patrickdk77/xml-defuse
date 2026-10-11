import { expect } from 'chai';
import { body, disarm, kind, xsl } from './helpers/util';

/** The kinds of XSLT finding a stylesheet gets, and what its output keeps of `probe`. */
async function check(stylesheet: string, probe: string) {
  const r = await disarm(stylesheet);
  return { status: r.status, kinds: r.before.findings.map(kind), kept: body(r).includes(probe) };
}

describe('XSLT expressions', () => {
  it('finds a call however comments, white space and string literals surround it', async () => {
    const calls = ["document(: a comment :)('x.xml')", "document (: (: nested :) :) ('x.xml')", "document\n('x.xml')", "concat('(:', document('x.xml'), ':)')"];
    for (const call of calls)
      expect(await check(xsl(`<xsl:template match="/"><xsl:copy-of select="${call}"/></xsl:template>`, '', '2.0'), 'x.xml'), call).to.deep.equal({
        status: 'defused',
        kinds: ['XSLT/DOCUMENT'],
        kept: false,
      });
    // A name inside a string or a comment is no call.
    expect(await check(xsl('<xsl:template match="/"><xsl:value-of select="concat(\'document(1)\', 2) (: doc(\'y\') :)"/></xsl:template>', '', '2.0'), 'concat')).to.deep.equal({
      status: 'clean',
      kinds: [],
      kept: true,
    });
  });

  it('reads URI-qualified names, named function references and function-lookup', async () => {
    const php = ' xmlns:php="http://php.net/xsl"';
    expect(await check(xsl('<xsl:template match="/"><xsl:value-of select="Q{http://php.net/xsl}function(\'f\')"/></xsl:template>', '', '3.0'), 'php.net/xsl}')).to.deep.equal({
      status: 'defused',
      kinds: ['XSLT/EXTENSION_FUNCTION'],
      kept: false,
    });
    expect(await check(xsl('<xsl:template match="/"><xsl:variable name="f" select="php:function#2"/></xsl:template>', php, '3.0'), 'php:function')).to.deep.equal({
      status: 'defused',
      kinds: ['XSLT/EXTENSION_FUNCTION'],
      kept: false,
    });
    expect(
      await check(xsl('<xsl:template match="/"><xsl:value-of select="Q{http://www.w3.org/2005/xpath-functions}unparsed-text(\'/etc/hosts\')"/></xsl:template>', '', '3.0'), '/etc/hosts'),
    ).to.deep.equal({
      status: 'defused',
      kinds: ['XSLT/DOCUMENT'],
      kept: false,
    });
    expect(await check(xsl('<xsl:template match="/"><xsl:value-of select="function-lookup(QName(\'urn:x\', \'f\'), 0)()"/></xsl:template>', '', '3.0'), 'function-lookup')).to.deep.equal({
      status: 'defused',
      kinds: ['XSLT/EVALUATE'],
      kept: false,
    });
  });

  it('reads attributes in the XSLT namespace on a literal result element as expressions', async () => {
    expect(await check(xsl('<xsl:template match="/"><out xsl:use-when="doc-available(\'file:///etc/passwd\')">x</out><kept/></xsl:template>', '', '3.0'), '<kept/>')).to.deep.equal({
      status: 'defused',
      kinds: ['XSLT/DOCUMENT'],
      kept: true,
    });
  });

  it('reads text value templates where expand-text is on, and the doubled braces of a literal brace as text', async () => {
    const on = xsl('<xsl:template match="/"><p>{unparsed-text(\'/etc/passwd\')}</p><q>{{literal}}</q></xsl:template>', ' expand-text="yes"', '3.0');
    const r = await disarm(on);
    expect({ status: r.status, kinds: r.before.findings.map(kind), out: body(r) }).to.deep.equal({
      status: 'defused',
      kinds: ['XSLT/DOCUMENT'],
      out: '<?xml version="1.0" encoding="UTF-8"?>\n<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="3.0" expand-text="yes"><xsl:template match="/"><q>{{literal}}</q></xsl:template></xsl:stylesheet>\n',
    });
    // With expand-text off, braces in text are text.
    expect(await check(xsl('<xsl:template match="/"><p>{unparsed-text(\'/etc/passwd\')}</p></xsl:template>', '', '3.0'), 'unparsed-text')).to.deep.equal({ status: 'clean', kinds: [], kept: true });
    expect(await check(xsl('<xsl:template match="/" expand-text="no"><p>{doc(\'a\')}</p></xsl:template>', ' expand-text="yes"', '3.0'), "doc('a')")).to.deep.equal({
      status: 'clean',
      kinds: [],
      kept: true,
    });
    // A call to an extension function in text goes with the element that holds the text.
    expect(await check(xsl('<xsl:template match="/"><p xsl:expand-text="yes">{php:function(\'f\')}</p><kept/></xsl:template>', ' xmlns:php="http://php.net/xsl"', '3.0'), '<kept/>')).to.deep.equal({
      status: 'defused',
      kinds: ['XSLT/EXTENSION_FUNCTION'],
      kept: true,
    });
  });
});
