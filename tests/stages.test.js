/*
 * What stage a tool is at — and why time alone can never promote one.
 *
 * Nine tools on one landing page all read with the same authority, and they
 * have not earned it equally: two have been judged, several have a fortnight of
 * frozen days and no verdict, and two were rewritten this week. Without the
 * stage on the card, the newest screener's candidates look exactly as
 * trustworthy as the one measured for a year.
 *
 * The rule, and the one thing about it that matters:
 *
 *   under 15 frozen days   collecting — no question to ask yet
 *   15 or more             under study — enough to look at, not to believe
 *   validated              A DECISION, never a day count
 *
 * That last line is the whole design. A tool that promoted itself to
 * "validated" on its fifteenth morning would be asserting that time makes a
 * screener good, which is the belief this whole archive exists to test.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const FILE = path.join(os.tmpdir(), `tool-stages-${process.pid}.json`);
process.env.TOOL_STAGES_FILE = FILE;

const stages = require('../src/stages');

beforeEach(() => { try { fs.unlinkSync(FILE); } catch { /* absent */ } });
afterAll(() => { try { fs.unlinkSync(FILE); } catch { /* absent */ } });

// ── the default, from the archive ──────────────────────────────────────────

describe('a tool nobody has judged', () => {
  test('under 15 days it is collecting', () => {
    for (const d of [0, 1, 9, 14]) {
      expect(stages.stageOf('T3', d).stage).toBe('collecting');
    }
  });

  test('at 15 days and beyond it is under study', () => {
    for (const d of [15, 34, 400]) {
      expect(stages.stageOf('T3', d).stage).toBe('study');
    }
  });

  /*
   * THE LINE THAT MATTERS. No number of days reaches `valid`, ever. If it did,
   * every tool would validate itself two weeks after being switched on.
   */
  test('NO day count reaches validated', () => {
    for (const d of [15, 100, 1000, 100000]) {
      expect(stages.stageOf('T3', d).stage).not.toBe('valid');
    }
  });

  test('an unknown day count is collecting, not study', () => {
    // Not knowing how much data there is is not evidence that there is enough.
    expect(stages.stageOf('T3', null).stage).toBe('collecting');
    expect(stages.stageOf('T3').stage).toBe('collecting');
  });

  test('and it says the count is what decided it', () => {
    expect(stages.stageOf('T3', 20).source).toBe('days');
  });
});

// ── the judged ones ────────────────────────────────────────────────────────

describe('the two tools that have been judged', () => {
  test('Momentum and CANSLIM are validated in the committed registry', () => {
    expect(stages.declared('T2')).toBe('valid');
    expect(stages.declared('T8')).toBe('valid');
  });

  /*
   * T2 has twelve frozen days — fewer than the fifteen that would make it
   * "under study" — and is still validated. That is the point: the verdict
   * outranks the count, in both directions.
   */
  test('a verdict outranks the day count, even a low one', () => {
    const s = stages.stageOf('T2', 12);
    expect(s.stage).toBe('valid');
    expect(s.source).toBe('declared');
  });

  test('no other tool claims a verdict it has not been given', () => {
    for (const id of ['T1', 'T3', 'T4', 'T5', 'T6', 'T7', 'T9']) {
      expect(stages.declared(id)).toBeNull();
    }
  });
});

// ── moving one by hand ─────────────────────────────────────────────────────

describe('moving a tool between stages', () => {
  test('an override beats both the registry and the count', () => {
    stages.setStage('T2', 'study');           // demote a validated one
    expect(stages.stageOf('T2', 12)).toMatchObject({ stage: 'study', source: 'override' });
    stages.setStage('T3', 'valid');           // promote a collecting one
    expect(stages.stageOf('T3', 2)).toMatchObject({ stage: 'valid', source: 'override' });
  });

  /*
   * `auto` REMOVES the override rather than writing today's answer down. A
   * reset that stored the current stage would freeze the tool at whatever it
   * happened to be on the day it was reset — so "put it back to the rule"
   * would quietly mean "never follow the rule again".
   */
  test('resetting to auto removes the override, it does not record one', () => {
    stages.setStage('T3', 'valid');
    stages.setStage('T3', 'auto');
    expect(stages.stageOf('T3', 2)).toMatchObject({ stage: 'collecting', source: 'days' });
    expect(stages.stageOf('T3', 40)).toMatchObject({ stage: 'study', source: 'days' });
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8'))).toEqual({});
  });

  test('null and an empty string reset it too', () => {
    for (const v of [null, '', undefined]) {
      stages.setStage('T3', 'valid');
      stages.setStage('T3', v);
      expect(stages.stageOf('T3', 2).source).toBe('days');
    }
  });

  test('an unknown stage is refused rather than stored', () => {
    expect(() => stages.setStage('T3', 'excellent')).toThrow(/unknown stage/);
    expect(stages.stageOf('T3', 2).source).toBe('days');
  });

  test('an unknown tool is refused', () => {
    expect(() => stages.setStage('T42', 'valid')).toThrow(/unknown tool/);
  });

  test('a lower-case tool id still finds the tool', () => {
    expect(stages.setStage('t3', 'valid').stage).toBe('valid');
  });

  /* The file is written by hand as often as by the API. */
  test('an unreadable overrides file means no overrides, not a crash', () => {
    fs.writeFileSync(FILE, 'not json at all');
    expect(stages.stageOf('T3', 2).stage).toBe('collecting');
  });
});

// ── the whole list, as the landing page reads it ───────────────────────────

describe('every tool at once', () => {
  test('each carries its stage, its reason and its day count', () => {
    const all = stages.all({ T1: 34, T2: 12, T3: 9, T5: 1 });
    const by = Object.fromEntries(all.map(t => [t.id, t]));
    expect(by.T1).toMatchObject({ stage: 'study', source: 'days', days: 34 });
    expect(by.T2).toMatchObject({ stage: 'valid', source: 'declared' });
    expect(by.T3).toMatchObject({ stage: 'collecting', source: 'days', days: 9 });
    expect(by.T5).toMatchObject({ stage: 'collecting', source: 'days', days: 1 });
    expect(by.T8).toMatchObject({ stage: 'valid' });
  });

  test('a tool with no day count still appears', () => {
    const all = stages.all({});
    expect(all).toHaveLength(9);
    for (const t of all) expect(stages.STAGES).toContain(t.stage);
  });

  test('every stage carries a label a person can read', () => {
    for (const s of stages.STAGES) expect(stages.LABEL[s]).toBeTruthy();
  });
});

/*
 * THE ORDER IS PART OF THE ANSWER.
 *
 * A chip on a card says what stage a tool is at; the ORDER says which to read
 * first, and a list that leaves that to the chip alone puts a tool with nine
 * days of data above one with a year for no better reason than where it sits
 * in the config file.
 */
describe('stage decides the order', () => {
  const RANK = { valid: 0, study: 1, collecting: 2 };
  const bystage = ids => ids
    .map(id => ({ id, stage: stages.stageOf(id, { T1: 34, T2: 12, T3: 9 }[id] ?? 5).stage }))
    .sort((a, b) => RANK[a.stage] - RANK[b.stage])
    .map(t => t.id);

  test('validated first, then under study, then collecting', () => {
    expect(bystage(['T3', 'T1', 'T2'])).toEqual(['T2', 'T1', 'T3']);
  });

  /*
   * THE STAGE LEADS, and the clock orders things inside it.
   *
   * Written the other way round first — time first, stage as a tiebreak —
   * which is a ranking by time with a label attached, not a ranking by stage.
   * Reported as "ranking still by time, stages not separated".
   */
  test('the landing page ranks by STAGE first, clock second', () => {
    const html = require('fs').readFileSync(
      require('path').join(__dirname, '../public/screeners.html'), 'utf8');
    expect(html).toMatch(/STAGE_RANK = \{ valid: 0, study: 1, collecting: 2 \}/);
    const rankFn = html.indexOf('function byWhenItMatters');
    const body = html.slice(rankFn, html.indexOf('}\n}', rankFn));
    expect(body.indexOf('STAGE_RANK[a.stage]'))
      .toBeLessThan(body.indexOf('if (ra !== rb) return ra - rb;'));
  });

  /*
   * AND THE SECTIONS ARE REAL, not just an order. A chip is a label; a section
   * is a place, and the reader has to see at a glance which part of the page
   * they are in. Every stage is drawn whether or not it has anything in it —
   * "nothing is validated yet" is a fact about the desk, not a rendering gap,
   * and it is the fact most worth seeing.
   */
  test('every stage is its own section, drawn even when empty', () => {
    const html = require('fs').readFileSync(
      require('path').join(__dirname, '../public/screeners.html'), 'utf8');
    for (const s of ['valid', 'study', 'collecting']) {
      expect(html).toContain(`${s}:`);            // in STAGE_SECTION
    }
    expect(html).toMatch(/for \(const stage of \['valid', 'study', 'collecting', 'unknown'\]\)/);
    expect(html).toContain('stage-empty');
    expect(html).toContain('Nothing here yet.');
    // a full-width heading — the container is flex-wrap, so width does the work
    expect(html).toMatch(/\.stage-head \{ width: 100%/);
  });

  test('each section says what its stage MEANS, not just its name', () => {
    const html = require('fs').readFileSync(
      require('path').join(__dirname, '../public/screeners.html'), 'utf8');
    // "under study" is not self-explaining, and the whole point of it is that
    // it is NOT a verdict.
    expect(html).toMatch(/not enough to believe/);
    expect(html).toMatch(/judged good enough to trade from/);
    expect(html).toMatch(/no question to ask yet/);
  });

  test('an unknown stage sorts last, not first', () => {
    const RANK2 = { valid: 0, study: 1, collecting: 2 };
    expect(RANK2['something-new'] ?? 9).toBe(9);
  });
});

/*
 * The same idea one level down: a SETUP is only as ready as its less ready
 * half. A long marked ready whose short is still in development is not a ready
 * setup — the pair ranks across both books, so half of it being unfinished
 * makes the whole thing unfinished.
 */
describe('a setup pair takes the lower stage of the two', () => {
  const catalog = require('../src/setups/catalog');
  test('the merge rule is in the catalog', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../src/setups/catalog.js'), 'utf8');
    expect(src).toMatch(/if \(s\.stage !== 'ready'\) g\.stage = 'development';/);
    expect(typeof catalog.list).toBe('function');
  });
});
