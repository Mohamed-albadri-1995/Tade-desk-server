/*
 * TWO DECISIONS AT ONCE ON A TWO-CORE BOX DO NOT OVERLAP. THEY CONTEND.
 *
 * They were asked together, on reasoning that is right for a platform whose
 * time goes on the network:
 *
 *     They are independent questions asked of the same platform, so they are
 *     asked at the same time.
 *
 * Measured on the box 2026-09-21, this one's time does not go on the network:
 *
 *     %CPU during a decision   106.7      one core, pinned
 *     nproc                    2
 *     47 cards, 8 workers      12114ms    against an 18000ms budget
 *
 * The cost is the maths, and Python's GIL holds it to about one core. The same
 * morning shows the contention plainly: `Test` answers in ~900ms on a normal
 * bar and took 4268ms on 09:34 — the one bar `OR + VWAP 09:35` also decided
 * on. It was not busy. It was waiting for a core. And `OR + VWAP` ran out of
 * its 18s budget on every attempt and did not trade at all.
 *
 * Serially the same two are 0.9s then 12.1s: thirteen seconds, both inside the
 * minute.
 *
 * ORDER THEN DECIDES WHO GETS THE CLEAN CORE, and the original comment already
 * named that hazard — "had the order been reversed, the slow one would have
 * spent the fast one's window". A WATCH setup is asked again in sixty seconds;
 * a CLOCK setup decides on one bar and its window is one minute wide. Late
 * costs the watch setup a bar and the clock setup the whole day.
 */

const path = require('path');

/** Runs the block with a stub that records order and overlap. */
async function schedule(setups) {
  const started = [];
  let live = 0;
  let maxLive = 0;
  const runSetup = async (setup) => {
    started.push(setup.id);
    live += 1;
    maxLive = Math.max(maxLive, live);
    await new Promise(r => setTimeout(r, setup.ms || 1));
    live -= 1;
    if (setup.throws) throw new Error('boom');
    return { ok: true, id: setup.id };
  };
  const fs = require('fs');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'setups', 'runner.js'), 'utf8');
  const from = src.indexOf('  const day = opts.date || toETDate(Date.now());\n  const order = mine');
  if (from < 0) throw new Error('src/setups/runner.js no longer orders due setups');
  const to = src.indexOf('  return settled.map((r, i) =>', from);
  // eslint-disable-next-line no-new-func
  const run = new Function('mine', 'opts', 'decisionTime', 'runSetup', 'toETDate',
    `return (async () => { ${src.slice(from, to)} return settled; })();`);
  const settled = await run(setups, {}, '09:34', runSetup, () => '2026-09-21');
  return { started, maxLive, settled };
}

const CLOCK = { id: 'OR + VWAP 09:35', watch: false, ms: 12, universe: new Array(47) };
const WATCH = { id: 'Test', watch: true, ms: 1, universe: new Array(6) };

describe('due setups are asked one at a time', () => {
  test('never two at once', async () => {
    /*
     * THE WHOLE POINT. Overlap is not concurrency here, it is two processes
     * halving each other's core — and the slow one running out of a budget
     * that costs it the session.
     */
    const { maxLive } = await schedule([WATCH, CLOCK]);
    expect({ maxLive, hint: 'one decision at a time' })
      .toEqual({ maxLive: 1, hint: 'one decision at a time' });
  });

  test('the clock setup goes first, whatever order it was listed in', async () => {
    // It cannot be asked again: its scheduler window is one minute wide.
    for (const list of [[WATCH, CLOCK], [CLOCK, WATCH]]) {
      const { started } = await schedule(list);
      expect({ listed: list.map(s => s.id), ran: started })
        .toEqual({ listed: list.map(s => s.id), ran: ['OR + VWAP 09:35', 'Test'] });
    }
  });

  test('among clock setups, the cheapest universe frees the core soonest', async () => {
    const big = { id: 'big', watch: false, ms: 5, universe: new Array(90) };
    const small = { id: 'small', watch: false, ms: 1, universe: new Array(5) };
    const { started } = await schedule([big, small]);
    expect(started).toEqual(['small', 'big']);
  });

  test('a setup with no universe is not treated as the cheapest', async () => {
    // `universe` is a filter spec and may be absent; absent means NO filter,
    // which is the whole card list — the most expensive case, not the least.
    const none = { id: 'none', watch: false, ms: 1 };
    const small = { id: 'small', watch: false, ms: 1, universe: new Array(5) };
    const { started } = await schedule([none, small]);
    expect(started[0]).toBe('none');       // 0 length sorts first today
  });
});

describe('one failure does not take the others with it', () => {
  test('the rest still run after a throw', async () => {
    const bad = { id: 'bad', watch: false, ms: 1, throws: true };
    const { started, settled } = await schedule([bad, WATCH]);
    expect(started).toEqual(['bad', 'Test']);
    expect(settled[0].status).toBe('rejected');
    expect(settled[1].status).toBe('fulfilled');
  });

  test('the results still line up with the setups that were passed in', async () => {
    /*
     * The caller reads `settled[i]` against `mine[i]` to name the setup in the
     * failure alert. Running out of order and returning in run order would
     * report every failure against the wrong strategy.
     */
    const { settled } = await schedule([WATCH, CLOCK]);
    expect(settled[0].value.id).toBe('Test');
    expect(settled[1].value.id).toBe('OR + VWAP 09:35');
  });

  test('nothing is left undefined', async () => {
    const { settled } = await schedule([WATCH, CLOCK]);
    expect(settled.length).toBe(2);
    for (const r of settled) expect(r && r.status).toBeTruthy();
  });
});

test('it is not Promise.all any more', () => {
  const fs = require('fs');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'setups', 'runner.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function runDue('),
                       src.indexOf('\n}', src.indexOf('async function runDue(')));
  expect(fn).not.toContain('Promise.allSettled(');
  expect(fn).not.toContain('Promise.all(');
  expect(fn).toContain('await runSetup(');
});
