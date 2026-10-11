import { expect } from 'chai';
import { bomOf, charsetFromContent, decoderFor, encodingFor, isUtf7Label, prescan } from '../src/encoding';
import { extensionOf, sniffMarkup, sniffType, typeFromName, typesDisagree } from '../src/sniff';
import { inspect } from './helpers/util';

const sniff = (s: string | Buffer) => {
  const r = sniffMarkup(Buffer.from(s));
  return r && `${r.kind}${r.xml ? ' (says XML)' : ''}`;
};

describe('reading the start of a file', () => {
  it('tells MHT, XML and HTML apart from the first bytes', () => {
    const cases: Array<[string | Buffer, string | undefined]> = [
      ['MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=b\r\n\r\n', 'mht'],
      ['Subject: x\r\nContent-Type:\r\n multipart/related; boundary=b\r\n\r\n', 'mht'],
      ['MIME-Version: 1.0\r\nContent-Type: text/html\r\n\r\n<p>', 'mht'],
      ['Content-Type: text/html\r\n\r\n<p>', undefined],
      ['MIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nx', undefined],
      ['<?xml version="1.0"?><html/>', 'xml (says XML)'],
      ['<!-- c --><?pi?><svg xmlns="http://www.w3.org/2000/svg"/>', 'xml (says XML)'],
      ['<svg width="1"/>', 'html'],
      ['<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml">', 'html'],
      // XHTML is read as XML first, but a namespace on an html element does not say the file is XML.
      ['<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "x"><html xmlns="http://www.w3.org/1999/xhtml">', 'xml'],
      ['<!DOCTYPE svg [<!ENTITY a "b">]><svg/>', 'xml (says XML)'],
      ['<html><body>', 'html'],
      ['  \n<P>text', 'html'],
      ['<config><a/></config>', 'xml'],
      ['<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform"/>', 'xml (says XML)'],
      ['plain text', undefined],
      ['', undefined],
      [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>x')]), 'html'],
      [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<?xml version="1.0"?><r/>', 'utf16le')]), 'xml (says XML)'],
      [Buffer.from('<r/>', 'utf16le'), 'xml'],
    ];
    for (const [input, want] of cases) expect(sniff(input), JSON.stringify(input.toString())).to.equal(want);
  });

  it('reads text without markup as a page, and refuses binary content', async () => {
    expect((await inspect('just text')).format).to.equal('html');
    expect((await inspect('')).status).to.equal('clean');
    for (const binary of [Buffer.from([0x41, 0, 0x42]), Buffer.from('%PDF-1.7\n'), Buffer.from('MZ\x90\x00'), Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')]) {
      const r = await inspect(binary);
      expect([r.status, r.findings.map(f => f.detail)]).to.deep.equal(['rejected', ['UNRECOGNIZED']]);
    }
  });

  it('knows file types by their signatures and names, and when they disagree', () => {
    expect([sniffType(Buffer.from('%PDF-1.4')), sniffType(Buffer.from('PK\x03\x04', 'latin1')), sniffType(Buffer.from('GIF89a'))]).to.deep.equal(['application/pdf', 'application/zip', 'image/gif']);
    expect([extensionOf('Page.HTML. '), extensionOf('noext'), typeFromName('x.svg'), typeFromName('x.constructor')]).to.deep.equal(['html', undefined, 'image/svg+xml', undefined]);
    expect([
      typesDisagree('image/png', 'a.png', 'image/png'),
      typesDisagree('image/gif', undefined, 'image/png'),
      typesDisagree('image/svg+xml', 'a.xml', 'application/xml'),
      typesDisagree('image/png', undefined, undefined),
    ]).to.deep.equal([false, true, false, true]);
  });
});

describe('encodings', () => {
  it('names encodings as the WHATWG Encoding Standard does, the replacement encoding included', () => {
    expect(['latin1', ' UTF8 ', 'shift_jis', 'iso-2022-kr', 'x-user-defined', 'bogus'].map(encodingFor)).to.deep.equal([
      'windows-1252',
      'utf-8',
      'shift_jis',
      'replacement',
      'x-user-defined',
      undefined,
    ]);
    expect([bomOf(Buffer.from([0xef, 0xbb, 0xbf])), bomOf(Buffer.from([0xfe, 0xff])), bomOf(Buffer.from('x'))]).to.deep.equal([
      { encoding: 'utf-8', length: 3 },
      { encoding: 'utf-16be', length: 2 },
      undefined,
    ]);
    expect([isUtf7Label('UTF-7'), isUtf7Label('csUnicode11UTF7'), isUtf7Label('utf-8')]).to.deep.equal([true, true, false]);
  });

  it('decodes as browsers do: x-user-defined into the private use area, and the replacement encoding into one U+FFFD', () => {
    expect(decoderFor('x-user-defined').decode(Buffer.from([0x41, 0x80, 0xff]))).to.equal('A\uF780\uF7FF');
    const r = decoderFor('replacement');
    expect([r.decode(Buffer.from('abc')), r.decode(Buffer.from('def'))]).to.deep.equal(['\uFFFD', '']);
    expect(decoderFor('windows-1252').decode(Buffer.from([0x93, 0x94]))).to.equal('\u201C\u201D');
  });

  it('finds the encoding a meta element declares in the first 1024 bytes, as the prescan does', () => {
    expect(prescan(Buffer.from('<!-- <meta charset="koi8-r"> --><meta charset="iso-8859-2">'))).to.deep.equal({ encoding: 'iso-8859-2', label: 'iso-8859-2' });
    expect(prescan(Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">'))?.encoding).to.equal('windows-1251');
    // content without the http-equiv pragma does not count, and UTF-16 becomes UTF-8.
    expect(prescan(Buffer.from('<meta content="charset=koi8-r">'))).to.equal(undefined);
    expect(prescan(Buffer.from('<meta charset="utf-16le">'))?.encoding).to.equal('utf-8');
    expect(prescan(Buffer.from(`${' '.repeat(1024)}<meta charset="koi8-r">`))).to.equal(undefined);
    expect([charsetFromContent('text/html;charset = "a b"'), charsetFromContent('charset'), charsetFromContent('x; charset=y;z')]).to.deep.equal(['a b', undefined, 'y']);
  });

  it('reads an HTML file by its byte order mark, then its meta element, then whether it is valid UTF-8', async () => {
    const latin = Buffer.concat([Buffer.from('<p>'), Buffer.from([0xe9])]);
    const utf8 = Buffer.from('<p>\u00E9');
    const declared = Buffer.concat([Buffer.from('<meta charset="koi8-r"><p>'), Buffer.from([0xc1])]);
    expect([(await inspect(latin)).encoding, (await inspect(utf8)).encoding, (await inspect(declared)).encoding]).to.deep.equal(['windows-1252', 'utf-8', 'koi8-r']);
  });
});

describe('extensionOf', () => {
  it('drops the dots and spaces Windows drops, and reads a long run of them in linear time', () => {
    const cases: Array<[string | undefined, string | undefined]> = [
      ['page.html.', 'html'],
      ['Page.HTML. ', 'html'],
      ['archive.tar.gz', 'gz'],
      ['.bashrc', 'bashrc'],
      ['noext', undefined],
      ['a.b/c', undefined],
      ['a.b\\c', undefined],
      ['...', undefined],
      ['', undefined],
      [undefined, undefined],
    ];
    for (const [name, ext] of cases) expect([name, extensionOf(name)]).to.deep.equal([name, ext]);
    const started = Date.now();
    expect([extensionOf(`${'.'.repeat(200_000)}a`), extensionOf(`${' .'.repeat(100_000)}z`), extensionOf('.'.repeat(200_000))]).to.deep.equal(['a', 'z', undefined]);
    expect(Date.now() - started).to.be.lessThan(200);
  });
});
