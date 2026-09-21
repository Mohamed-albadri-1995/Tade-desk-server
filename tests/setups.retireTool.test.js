/*
 * STOPPING A SCREENER IS TWO FACTS IN TWO PLACES.
 *
 * "I also want to stop t10 the breakout screener and let the setup work with
 * only t11."
 *
 * That is two changes, and each one alone leaves the desk in a state that
 * looks correct:
 *
 *   tools.config.json   enabled:false — the tool stops COLLECTING. Lives in
 *                       this repo, travels on a deploy.
 *
 *   the strategy in qp  `tools` — which card lists a setup is RUN against.
 *                       Lives in qp's database. No commit touches it.
 *
 * Do only the first and the setup still names the sleeping tool. Its run there
 * finds an empty card list every morning and reports "no cards" — the same
 * words a live tool says on a quiet day. A screener that is off reads exactly
 * like a screener that found nothing, on the page you check when a setup did
 * not fire.
 *
 * THE THING THIS MUST NOT DO is take the last tool off a strategy. catalog.js
 * drops a strategy with no tools from the setups list entirely — "something
 * being worked on in qp" — so it stops being scheduled, stops appearing on the
 * Algo page, and does so with no message anywhere. That is a deletion wearing
 * an edit's clothes.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { planFor } = require(path.join(ROOT, 'scripts', 'retire-tool'));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8'));
const tool = id => (cfg.tools || []).find(t => t.id === id);

const S = (name, tools) => ({ id: name.toLowerCase(), name, tools });

describe('T10 is asleep in the registry', () => {
  test('it no longer scans, and its scorer is off with it', () => {
    expect({ enabled: tool('T10').enabled, scorer: tool('T10').scorer })
      .toEqual({ enabled: false, scorer: false });
  });

  test('but everything it collected is still readable', () => {
    /*
     * `archive: true` is the difference between stopping a tool and losing it.
     * The read-only archive process serves its stored registers on its own
     * port, so every day T10 ever photographed can still be charted and
     * backtested — which is the whole reason its history was split out of T8
     * in the first place.
     */
    expect(tool('T10').archive).toBe(true);
    // The same shape as the four tools already retired, so the landing page,
    // check-screeners and the archive all treat it the same way.
    for (const id of ['T3', 'T4', 'T5', 'T8', 'T9']) {
      expect({ id, asleep: tool(id).enabled === false, kept: tool(id).archive === true })
        .toEqual({ id, asleep: true, kept: true });
    }
  });

  test('and the description says so, rather than still selling it', () => {
    // The registry's `desc` is what the landing page and the suite print. A
    // stopped tool describing itself in the present tense is a card that lies.
    expect(tool('T10').desc).toMatch(/Stopped 2026-09-21/);
    expect(tool('T10').desc).toContain('T11');
  });

  test('T11 is untouched — it is the one that keeps running', () => {
    expect({ enabled: tool('T11').enabled, archive: tool('T11').archive })
      .toEqual({ enabled: true, archive: undefined });
    // Its capture minute above all: the split exists so the two halves stay
    // comparable with their own history, and moving T11's clock now would
    // break that on the day the other half stopped.
    expect(tool('T11').captureAt.r1).toBe('09:46');
    expect(tool('T11').splitFrom).toBe('T8');
  });
});

describe('what the script would change, decided before anything is written', () => {
  test('a setup on both is left on the other one', () => {
    const { doable, refused } = planFor([S('Growth', ['T10', 'T11'])], 'T10');
    expect(refused).toEqual([]);
    expect(doable.map(p => p.to)).toEqual([['T11']]);
  });

  test('a setup that does not name it is not touched', () => {
    const { plans } = planFor([S('OR + VWAP', ['T2']), S('Fade', ['T6'])], 'T10');
    expect(plans).toEqual([]);
  });

  test('the order of what is left is the order it was in', () => {
    // These are printed for a person to check against what they meant. A list
    // that comes back re-sorted is a diff that reads as a second change.
    const { doable } = planFor([S('Three', ['T11', 'T10', 'T2'])], 'T10');
    expect(doable[0].to).toEqual(['T11', 'T2']);
  });

  test('a strategy naming it twice comes back without it at all', () => {
    // A duplicate is not a shape that should exist, and removing "the first
    // one" would leave the setup still running on a sleeping tool while the
    // script reported success.
    const { doable } = planFor([S('Dup', ['T10', 'T11', 'T10'])], 'T10');
    expect(doable[0].to).toEqual(['T11']);
  });
});

describe('what it refuses', () => {
  test('taking the last tool off a strategy', () => {
    /*
     * A strategy with no tools is dropped by catalog.js. It stops being
     * scheduled and stops appearing on the Algo page, silently — so this is a
     * deletion, and a deletion is not something a tool-assignment script gets
     * to do on the way past.
     */
    const { doable, refused } = planFor([S('Only T10', ['T10'])], 'T10');
    expect(doable).toEqual([]);
    expect(refused.map(p => p.s.name)).toEqual(['Only T10']);
  });

  test('and the refusal does not block the ones that are fine', () => {
    const { doable, refused } = planFor(
      [S('Only T10', ['T10']), S('Growth', ['T10', 'T11'])], 'T10');
    expect(doable.map(p => p.s.name)).toEqual(['Growth']);
    expect(refused.map(p => p.s.name)).toEqual(['Only T10']);
  });

  test('the rule it is enforcing is the one catalog.js actually applies', () => {
    // If catalog stopped dropping toolless strategies this refusal would be
    // protecting nothing, and the script would be blocking a safe change.
    const cat = fs.readFileSync(path.join(ROOT, 'src', 'setups', 'catalog.js'), 'utf8');
    expect(cat).toContain('if (!tools.length) continue;');
  });
});

describe('shapes qp can return that are not a list of two strings', () => {
  test('a missing or non-array tools field is skipped, not crashed on', () => {
    // AN ERROR IS NEVER A ZERO the other way round too: a strategy with no
    // tools field is not a strategy that runs on T10.
    const odd = [{ id: 'a', name: 'No field' }, { id: 'b', name: 'Null', tools: null },
                 { id: 'c', name: 'String', tools: 'T10' }, null, undefined];
    expect(planFor(odd, 'T10').plans).toEqual([]);
  });

  test('an empty answer is an empty plan', () => {
    for (const v of [[], null, undefined]) {
      expect({ v, plans: planFor(v, 'T10').plans.length }).toEqual({ v, plans: 0 });
    }
  });
});

/*
 * THE PART THE SCRIPT CANNOT DO, AND MUST NOT PRETEND TO.
 *
 * The universe a setup trades is part of what its backtest measured. Going
 * from two screeners to one is a change to the thing itself, not a setting:
 * the expectancy, the win rate and the position size that came off that
 * backtest were measured over picks the setup will no longer see.
 */
describe('the backtest is not quietly dragged along', () => {
  test('parity still refuses to copy a universe across', () => {
    const parity = fs.readFileSync(path.join(ROOT, 'src', 'setups', 'parity.js'), 'utf8');
    expect(parity).toContain('const btTools = ((bt.universe || {}).tools || []);');
    expect(parity).toContain('change the strategy\'s tools ');
  });

  test('and the script says so out loud after it writes', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'retire-tool.js'), 'utf8');
    expect(src).toContain('THE BACKTEST NOW MEASURES A DIFFERENT UNIVERSE');
    // Said only when something was actually changed — a warning printed on a
    // dry run is a warning that stops being read.
    const at = src.indexOf('THE BACKTEST NOW MEASURES');
    expect(src.lastIndexOf('if (done) {', at)).toBeGreaterThan(src.indexOf('let done = 0;'));
  });

  test('it does not write on a dry run', () => {
    /*
     * The default has to be "tell me", because the thing it changes is not in
     * git and there is nothing to revert to.
     */
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'retire-tool.js'), 'utf8');
    const applyAt = src.indexOf('if (!APPLY) {');
    const writeAt = src.indexOf('await qp.setTools(');
    expect({ guardFirst: applyAt > 0 && applyAt < writeAt }).toEqual({ guardFirst: true });
    expect(src).toContain("const APPLY = args.includes('--apply');");
  });

  test('a qp that did not answer is not read as "nothing uses T10"', () => {
    // The same empty list, and the opposite conclusion. The script dies on the
    // error rather than reporting a clean result.
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'retire-tool.js'), 'utf8');
    const fn = src.slice(src.indexOf('let strategies;'), src.indexOf('const mine ='));
    expect(fn).toContain('qp did not answer');
    expect(fn).toContain('Nothing was changed.');
  });

  test('requiring the script does not make it talk to qp', () => {
    // It is required at the top of this file. A script that runs main() on
    // load is a script no test can load, and this one connects to a live
    // platform.
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'retire-tool.js'), 'utf8');
    expect(src).toContain('if (require.main === module) {');
  });
});
