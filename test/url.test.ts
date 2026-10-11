import { expect } from 'chai';
import { checkLink, cleanUrl, decodeDataUrl, hostsIn, isScriptScheme, LabelSites, resourceTarget, schemeOf } from '../src/url';

describe('URLs', () => {
  it('reads a URL as a browser does: controls and spaces at the ends go, and tabs and line ends anywhere', () => {
    expect(cleanUrl('\u0000 java\tscr\nipt:x \u0001')).to.equal('javascript:x');
    expect(schemeOf(' JaVa\tScript:alert(1)')).to.equal('javascript');
    expect(schemeOf('page.html#x:y')).to.equal(undefined);
    expect(['javascript', 'vbscript', 'livescript', 'mocha', 'data', undefined].map(isScriptScheme)).to.deep.equal([true, true, true, true, false, false]);
  });

  it('classifies where a resource loads from', () => {
    const cases: Record<string, string> = {
      '': 'none',
      '#frag': 'none',
      'about:blank': 'none',
      'about:srcdoc': 'other',
      'cid:part1@x': 'part',
      'mid:m@x': 'part',
      'data:image/png;base64,AA==': 'data',
      'javascript:x': 'script',
      'C:\\x.png': 'local',
      'file:///etc/passwd': 'local',
      'file://localhost/x': 'local',
      'file://server/share/x': 'network',
      '\\\\server\\share': 'network',
      'smb://server/x': 'network',
      'https://example.net/x': 'remote',
      '//example.net/x': 'remote',
      'img/x.png': 'remote',
      'ms-its:x.chm::/a': 'other',
      'mhtml:file://x.mht!a': 'other',
    };
    expect(Object.fromEntries(Object.keys(cases).map(u => [u, resourceTarget(u)]))).to.deep.equal(cases);
  });

  it('classifies a link target as pdf-defuse does', () => {
    const cases: Record<string, string> = {
      'https://example.com/x': 'SAFE',
      'mailto:a@example.com': 'SAFE',
      'javascript:x': 'URL',
      'data:text/html,x': 'DATA_URL',
      'file:///C:/x': 'FILE_URL',
      'C:/x': 'FILE_URL',
      '\\\\host\\share': 'NETWORK_PATH',
      'file://host/share': 'NETWORK_PATH',
      'ftp://example.com/': 'OTHER_SCHEME',
      'https://user:pw@example.com/': 'CREDENTIALS',
      'https://example.com@evil.example/': 'CREDENTIALS',
      'http://10.0.0.1/': 'IP_HOST',
      'http://0x7f000001/': 'IP_HOST',
      'http://[::1]/': 'IP_HOST',
      'https://xn--e1afmkfd.example/': 'LOOKALIKE_HOST',
      'https://ex%61mple.com/': 'ENCODED_HOST',
      'page.html': 'RELATIVE',
    };
    expect(Object.fromEntries(Object.keys(cases).map(u => [u, checkLink(u).detail]))).to.deep.equal(cases);
  });

  it('resolves a relative link against a base address that is itself safe', () => {
    expect(checkLink('page.html', 'https://example.com/dir/')).to.deep.include({ detail: 'SAFE', host: 'example.com' });
    expect(checkLink('page.html', 'javascript:x').detail).to.equal('RELATIVE');
  });

  it('finds host names in text, and matches them with subdomains either way', () => {
    expect(hostsIn('Go to https://Bank.Example.com/login or www.example.org. Version 1.2 is no host.')).to.deep.equal(['bank.example.com', 'www.example.org']);
    const sites = new LabelSites(['www.example.com', 'shop.example.net']);
    expect(['example.com', 'login.example.com', 'example.net', 'other.example.net', 'example.org'].map(h => sites.has(h))).to.deep.equal([true, true, true, false, false]);
  });

  it('decodes data: URLs as the fetch standard reads them', () => {
    expect(decodeDataUrl('data:,a%20b')).to.deep.equal({ type: 'text/plain', bytes: Buffer.from('a b') });
    expect(decodeDataUrl(' DATA:Image/PNG;x=y;base64,QU\nJD ')).to.deep.equal({ type: 'image/png', bytes: Buffer.from('ABC') });
    expect(decodeDataUrl('data:text/html;charset=utf-8,%3Cb%3E')).to.deep.equal({ type: 'text/html', bytes: Buffer.from('<b>') });
    expect(decodeDataUrl('https://example.com/')).to.equal(undefined);
  });
});
