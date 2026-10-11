import { expect } from 'chai';
import { XmlCategory as C, COMBINATIONS, XmlDetail as D, DEFAULT_BANDS, type DefuseFinding, scoreFindings, type XmlOptions } from '../src';
import { FindingFactory } from '../src/findings';
import { inspect, page } from './helpers/util';

const f = (c: C, d: D, action: 'strip' | 'info' = 'strip'): DefuseFinding => ({ ...new FindingFactory().make(c, d), action });

describe('scoring', () => {
  it('counts the highest weight in full and a quarter of each other kind, each kind once', () => {
    const s = (fs: DefuseFinding[], o: XmlOptions = {}) => scoreFindings(fs, o);
    expect(s([])).to.deep.equal({ score: 0, risk: 'NONE' });
    expect(s([f(C.Navigation, D.Base)])).to.deep.equal({ score: 30, risk: 'MEDIUM' });
    expect(s([f(C.Navigation, D.Base), f(C.Navigation, D.Base), f(C.External, D.Resource)])).to.deep.equal({ score: 33, risk: 'MEDIUM' });
    expect(s([f(C.Script, D.Element), f(C.Embedded, D.Object)])).to.deep.equal({ score: 100, risk: 'CRITICAL' });
    expect(s([f(C.Script, D.Element)], { scoreBands: { ...DEFAULT_BANDS, high: 80, critical: 95 } }).risk).to.equal('MEDIUM');
  });

  it('adds each combination once, and only for findings that weigh something', () => {
    const names = COMBINATIONS.map(c => c.name);
    expect(names).to.include('a password field with a form that sends data');
    expect(scoreFindings([f(C.Form, D.Password, 'info'), f(C.Form, D.Submit)], {}).score).to.equal(40 + 5 + 20);
    expect(scoreFindings([f(C.Form, D.Password, 'info'), f(C.Form, D.Submit)], { scoreWeights: [{ category: C.Form, detail: D.Password, weight: 0 }] }).score).to.equal(40);
  });

  it("takes the caller's weights for a detail before those for its category", () => {
    const weights = {
      scoreWeights: [
        { category: C.Script, weight: 5 },
        { category: C.Script, detail: D.Element, weight: 9 },
      ],
    };
    expect(scoreFindings([f(C.Script, D.Element)], weights).score).to.equal(9);
    expect(scoreFindings([f(C.Script, D.EventHandler)], weights).score).to.equal(5);
  });

  it('scores an upload without what plugins kept, and gives no score to a file a limit stopped', async () => {
    expect((await inspect(page('<p onclick="x()">k</p>'))).score).to.equal(60);
    const stopped = await inspect(page('<p>k</p>'), { limits: { fileSize: 5 } });
    expect([stopped.score, stopped.risk]).to.deep.equal([null, 'UNKNOWN']);
  });
});
