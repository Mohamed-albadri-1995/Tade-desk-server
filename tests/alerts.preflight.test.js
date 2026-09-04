/*
 * UNTESTED IS NOT PASSED.
 *
 * The whole feature is one rule, and this file is mostly about that rule
 * holding at every boundary.
 *
 * A test signal was sent from the Algo tab and came back clean, and the honest
 * reading was: one leg of seven proven, six unknown. `Test 1 share` posts one
 * AAPL share to ONE account through its TEST hook. It runs no scanner, reads
 * no card list, asks qp nothing, sizes nothing, resolves no routing — and its
 * ledger row is written `date: null`, so `broker.reconciled(date)` filters it
 * out and neither confirm nor the journal can ever see it.
 *
 * Every failure this desk has had in the past week was a silence read as a
 * pass: a scan that never ran, a stage never invoked, a decision taken on a
 * fifteen-minute-old bar, a `confirmed()` nothing called. Each looked like
 * "fine". So a leg this cannot answer must come back `null`, and `null` must
 * never be counted, coloured or summarised as a pass.
 */

const pf = require('../src/alerts/preflight');

const okSetup = (over = {}) => ({
  id: 'T8 Test@09:30', name: 'Test', tools: ['T8'], enabled: true,
  autoTrade: true, liveFeed: 'polygon',
  readiness: { orderOk: true, orderBlocking: [] },
  ...over,
});

/* ── the rule itself ─────────────────────────────────────────────────────── */

describe('a group is as good as its worst member', () => {
  test('any failure fails the leg', () => {
    expect(pf.verdict([{ ok: true }, { ok: false }])).toBe(false);
  });

  test('an unknown outranks a pass — one account that cannot be read makes '
    + 'the leg not proven, however good the other one is', () => {
    expect(pf.verdict([{ ok: true }, { ok: null }])).toBeNull();
  });

  test('a failure outranks an unknown, because a known break is the thing to '
    + 'fix first', () => {
    expect(pf.verdict([{ ok: null }, { ok: false }])).toBe(false);
  });

  test('all pass is a pass', () => {
    expect(pf.verdict([{ ok: true }, { ok: true }])).toBe(true);
  });

  test('nothing to check is UNKNOWN, not a pass — an empty check that reported '
    + 'green is the purest form of this bug', () => {
    expect(pf.verdict([])).toBeNull();
  });
});

/* ── the report survives its own failures ────────────────────────────────── */

function deps(over = {}) {
  return {
    broker: {
      publicSettings: () => ({ destinations: [] }),
      orders: () => [],
      autoRoute: () => ({ cfgs: [], error: 'no account runs this setup' }),
      callbackUrl: () => 'https://example/api/broker/callback/tok',
      ...over.broker,
    },
    reconcile: {
      credentialScope: () => ({ ids: [], readable: [], blind: [],
                                ambiguous: false, reason: null }),
      confirmed: async () => ({ ok: true, rows: [], verifiable: false }),
      ...over.reconcile,
    },
    catalog: { list: async () => [okSetup()], ...over.catalog },
    sessionLog: { summaryOf: () => ({}), ...over.sessionLog },
    fetchJson: over.fetchJson || (async () => { throw new Error('no tool here'); }),
    toolsFile: over.toolsFile,
  };
}

describe('the report is the thing you open when the day is bad', () => {
  test('one leg throwing does not take the report down, and comes back as '
    + 'UNKNOWN rather than broken', async () => {
    const d = deps({ reconcile: {
      credentialScope: () => { throw new Error('boom'); },
    } });
    const out = await pf.check({ day: '2026-09-03', deps: d });
    expect(out.ok).toBe(true);
    expect(out.legs).toHaveLength(7);
    const j = out.legs.find(l => l.id === 'journal');
    // NOT `false`. "Broken" is a claim about the desk; "I could not find out"
    // is a claim about this check, and reporting the second as the first sends
    // you looking in the wrong place.
    expect(j.ok).toBeNull();
    expect(j.note).toMatch(/boom/);
  });

  test('every leg reports even when the setup list cannot be read', async () => {
    const out = await pf.check({ day: '2026-09-03', deps: deps({
      catalog: { list: async () => { throw new Error('qp unreachable'); } },
    }) });
    expect(out.ok).toBe(true);
    expect(out.legs.find(l => l.id === 'setups').ok).toBeNull();
    expect(out.legs.find(l => l.id === 'setups').note).toMatch(/qp unreachable/);
  });

  test('the three states are counted apart on the headline', async () => {
    const out = await pf.check({ day: '2026-09-03', deps: deps() });
    expect(out.passed + out.failed + out.untested).toBe(out.legs.length);
    // AND THE COUNTS COME FROM THE LEGS, not from a tally kept alongside them.
    expect(out.passed).toBe(out.legs.filter(l => l.ok === true).length);
    expect(out.untested).toBe(out.legs.filter(l => l.ok === null).length);
  });

  test('it says outright that it placed nothing', async () => {
    const out = await pf.check({ day: '2026-09-03', deps: deps() });
    expect(out.note).toMatch(/places no order/);
    expect(out.note).toMatch(/not a leg that passed/);
  });
});

/* ── leg 2: the feed ─────────────────────────────────────────────────────── */

describe('the feed', () => {
  test('a fifteen-minute lag FAILS, and names the feed and the count', () => {
    const l = pf.legFeed([okSetup({ liveFeed: 'yahoo' })], {
      'T8 Test@09:30': { lagMaxMin: 15, lagBars: 90, runs: 120 },
    });
    expect(l.ok).toBe(false);
    expect(l.note).toMatch(/yahoo/);
    expect(l.note).toMatch(/15 min behind on 90 of 120/);
  });

  test('a delayed source with no measurement yet is UNKNOWN, not a pass — it '
    + 'is exactly the state that looked like a quiet market', () => {
    const l = pf.legFeed([okSetup({ liveFeed: 'yahoo' })], {});
    expect(l.ok).toBeNull();
    expect(l.note).toMatch(/15 min delayed/);
  });

  test('a real-time feed with a measured lag of zero passes', () => {
    const l = pf.legFeed([okSetup({ liveFeed: 'alpaca' })], {
      'T8 Test@09:30': { lagMaxMin: 0, lagBars: 0, runs: 40 },
    });
    expect(l.ok).toBe(true);
  });

  test('a real-time feed nobody has measured yet is UNKNOWN', () => {
    expect(pf.legFeed([okSetup({ liveFeed: 'alpaca' })], {}).ok).toBeNull();
  });

  test('one bar of lag is tolerated — the same tolerance the stale guard uses',
    () => {
      const l = pf.legFeed([okSetup({ liveFeed: 'alpaca' })], {
        'T8 Test@09:30': { lagMaxMin: 1, lagBars: 0, runs: 40 },
      });
      expect(l.ok).toBe(true);
      expect(pf.LAG_BAD_MIN).toBe(2);
    });

  /*
   * POLYGON CANNOT DECIDE A LIVE BAR. A day behind on the free plan, five
   * requests a minute: forty symbols cannot finish inside a clock setup's
   * minute. On 2026-09-04 that was the whole of "MISSED THE 09:35 WINDOW",
   * and it was reported as the platform being slow. It FAILS here even with
   * no measurement, because the measurement can only ever be a timeout.
   */
  test('polygon as the live feed FAILS outright, measured or not', () => {
    const l = pf.legFeed([okSetup({ liveFeed: 'polygon' })], {});
    expect(l.ok).toBe(false);
    expect(l.note).toMatch(/cannot decide a live bar/);
    expect(l.note).toMatch(/five requests a minute/);
    expect(pf.LIVE_UNUSABLE_FEEDS.has('polygon')).toBe(true);
  });

  /*
   * AND THE LIST IS NOT A COPY. This was `new Set(['polygon'])`, typed here,
   * while the list it mirrors grew two entries: `hybrid` and `hybrid_yahoo`
   * fetch Polygon's history once per symbol before reaching the source that is
   * current, so they hit the identical five-a-minute ceiling. A check holding
   * a stale copy of the thing it checks reports "fine" about a case it has
   * never heard of — and this one would have passed a setup that times out
   * every morning.
   */
  test('hybrid and hybrid_yahoo fail it too, from feeds.js\'s own list', () => {
    const { LIVE_UNUSABLE } = require('../src/setups/feeds');
    for (const f of ['hybrid', 'hybrid_yahoo']) {
      expect(pf.LIVE_UNUSABLE_FEEDS.has(f)).toBe(true);
      expect(pf.legFeed([okSetup({ liveFeed: f })], {}).ok).toBe(false);
    }
    expect([...pf.LIVE_UNUSABLE_FEEDS].sort()).toEqual(Object.keys(LIVE_UNUSABLE).sort());
  });

  /*
   * A MISSING FEED IS NOT YAHOO. This read `s.liveFeed || 'yahoo'`, so a setup
   * the catalog had failed to describe was reported, in full sentences, as
   * being on a feed nobody had put it on — an absence printed where an answer
   * belongs, in the file written to stop exactly that.
   */
  test('a setup with no feed at all is UNKNOWN, and is not called yahoo', () => {
    const l = pf.legFeed([okSetup({ liveFeed: null })], {});
    expect(l.ok).toBeNull();
    expect(l.detail[0].feed).toBeNull();
    expect(l.note).toMatch(/did not say which feed/);
    expect(l.note).not.toMatch(/yahoo/);
  });

  /*
   * WHAT THE TRADER SPOTTED ON THE PAGE: one setup on alpaca, one on yahoo,
   * and nothing anywhere saying so. It is not a fault — a setup can be pinned
   * deliberately — but it means a rehearsal that passes on one of them covers
   * nothing about the other: different tapes, different delays, prices that do
   * not agree to the cent.
   */
  test('setups on different feeds are named as such', () => {
    const l = pf.legFeed([
      okSetup({ id: 'a', liveFeed: 'alpaca' }),
      okSetup({ id: 'b', liveFeed: 'yahoo' }),
    ], { a: { lagMaxMin: 0, lagBars: 0, runs: 10 } });
    expect(l.note).toMatch(/not all on one feed \(alpaca, yahoo\)/);
    expect(l.note).toMatch(/does not cover the others/);
  });

  test('…and one feed across every setup says nothing about mixing', () => {
    const l = pf.legFeed([
      okSetup({ id: 'a', liveFeed: 'alpaca' }),
      okSetup({ id: 'b', liveFeed: 'alpaca' }),
    ], {});
    expect(l.note).not.toMatch(/not all on one feed/);
  });
});

/* ── leg 3: the decision ─────────────────────────────────────────────────── */

describe('the decision', () => {
  test('a setup that cannot order FAILS and names what blocks it', () => {
    const l = pf.legDecision([okSetup({
      readiness: { orderOk: false, orderBlocking: ['no exit protocol reported'] },
    })], {});
    expect(l.ok).toBe(false);
    expect(l.note).toMatch(/no exit protocol reported/);
  });

  test('a setup not on auto FAILS — it alerts, and an alert is not an order',
    () => {
      expect(pf.legDecision([okSetup({ autoTrade: false })], {}).ok).toBe(false);
    });

  test('a setup that has not run today is UNKNOWN, because outside its window '
    + 'that is correct and this cannot tell the two apart', () => {
    const l = pf.legDecision([okSetup()], {});
    expect(l.ok).toBeNull();
    expect(l.note).toMatch(/correct outside its window/);
  });

  test('runs that FAILED are a failure, and the first reason travels with it',
    () => {
      const l = pf.legDecision([okSetup()], {
        'T8 Test@09:30': { runs: 120, failed: 3, lastBar: '11:29',
                           problems: ['timeout of 18000ms exceeded'] },
      });
      expect(l.ok).toBe(false);
      expect(l.note).toMatch(/3 of 120 runs FAILED/);
      expect(l.note).toMatch(/timeout/);
    });

  test('asked all morning with no failures passes', () => {
    const l = pf.legDecision([okSetup()], {
      'T8 Test@09:30': { runs: 120, failed: 0, lastBar: '11:29' },
    });
    expect(l.ok).toBe(true);
  });
});

/* ── leg 5: the hooks ────────────────────────────────────────────────────── */

describe('the live hook', () => {
  const dest = (over = {}) => ({ id: 'alpaca1', name: 'Alpaca 1', enabled: true,
                                 hasWebhook: true, hasTestWebhook: true, ...over });

  test('a live hook that has never carried an order is UNTESTED, and says the '
    + 'Test button did not prove it', () => {
    const l = pf.legHooks({
      publicSettings: () => ({ destinations: [dest()] }),
      orders: () => [{ hook: 'test', sent: true, destination: 'alpaca1' }],
    });
    expect(l.ok).toBeNull();
    expect(l.note).toMatch(/never carried an order/);
    expect(l.note).toMatch(/TEST hook/);
  });

  test('...and one real order through it flips the leg to proven', () => {
    const l = pf.legHooks({
      publicSettings: () => ({ destinations: [dest()] }),
      orders: () => [{ hook: 'live', sent: true, destination: 'alpaca1',
                       at: Date.parse('2026-09-03T13:41:00Z') }],
    });
    expect(l.ok).toBe(true);
    expect(l.note).toMatch(/carried 1 order/);
  });

  test('an account with no live hook FAILS', () => {
    const l = pf.legHooks({
      publicSettings: () => ({ destinations: [dest({ hasWebhook: false })] }),
      orders: () => [],
    });
    expect(l.ok).toBe(false);
  });

  test('two accounts, one proven and one not, is NOT proven — the untested one '
    + 'decides', () => {
    const l = pf.legHooks({
      publicSettings: () => ({ destinations: [dest(), dest({ id: 'alpaca2', name: 'Alpaca 2' })] }),
      orders: () => [{ hook: 'live', sent: true, destination: 'alpaca1', at: Date.now() }],
    });
    expect(l.ok).toBeNull();
    expect(l.detail.find(d => d.account === 'Alpaca 2').ok).toBeNull();
  });

  test('no broker at all is a failure, not an unknown — nothing can trade',
    () => {
      expect(pf.legHooks({ publicSettings: () => ({ destinations: [] }),
                           orders: () => [] }).ok).toBe(false);
    });
});

/* ── leg 6: the feedback ─────────────────────────────────────────────────── */

describe('the feedback', () => {
  const rec = { confirmed: async () => ({ ok: true, rows: [], verifiable: false }) };

  test('with only dateless TEST orders on the ledger the leg is UNTESTED, and '
    + 'says the Test button cannot prove it', async () => {
    const l = await pf.legFeedback('2026-09-03', {
      callbackUrl: () => 'https://x/api/broker/callback/tok',
      orders: () => [{ at: 1, date: null, source: 'manual test', sent: true,
                       symbol: 'AAPL' }],
    }, rec);
    expect(l.ok).toBeNull();
    expect(l.note).toMatch(/CANNOT prove this leg/);
    expect(l.note).toMatch(/dateless/);
  });

  test('no callback URL at all is a FAILURE — the ledger would record '
    + 'intentions and call them outcomes', async () => {
    const l = await pf.legFeedback('2026-09-03',
      { callbackUrl: () => { throw new Error('none'); }, orders: () => [] }, rec);
    expect(l.ok).toBe(false);
    expect(l.note).toMatch(/no callback URL/);
  });

  test('a URL set but never hit is UNTESTED, with the fix named', async () => {
    const l = await pf.legFeedback('2026-09-03', {
      callbackUrl: () => 'https://x/api/broker/callback/tok',
      orders: () => [{ at: 1, date: '2026-09-02', sent: true, symbol: 'AAPL' }],
    }, rec);
    expect(l.ok).toBeNull();
    expect(l.note).toMatch(/Call webhook/);
  });

  test('callbacks received and nothing sent today is a PASS — the leg works, '
    + 'there was simply nothing to confirm', async () => {
    const l = await pf.legFeedback('2026-09-03', {
      callbackUrl: () => 'https://x/api/broker/callback/tok',
      orders: () => [{ at: Date.parse('2026-09-02T14:00:00Z'), kind: 'callback',
                       orderId: '1' }],
    }, rec);
    expect(l.ok).toBe(true);
    expect(l.note).toMatch(/nothing to confirm/);
  });

  test('orders today with no word back from anyone FAILS', async () => {
    const l = await pf.legFeedback('2026-09-03', {
      callbackUrl: () => 'https://x/api/broker/callback/tok',
      orders: () => [{ at: 1, kind: 'callback', orderId: '9' }],
    }, {
      confirmed: async () => ({ ok: true, verifiable: true, rows: [
        { symbol: 'AAA', confirmed: false, confirmedBy: null },
        { symbol: 'BBB', confirmed: true, confirmedBy: 'alpaca' },
      ] }),
    });
    expect(l.ok).toBe(false);
    expect(l.note).toMatch(/1 of 2/);
    expect(l.note).toMatch(/never heard from again/);
  });
});

/* ── leg 7: the journal ──────────────────────────────────────────────────── */

describe('the journal', () => {
  test('an account the journal cannot read FAILS, and reuses the reason that '
    + 'is already written for a person', () => {
    const l = pf.legJournal({ credentialScope: () => ({
      ids: ['alpaca1', 'alpaca2'], readable: ['alpaca1'], blind: ['alpaca2'],
      ambiguous: true, reason: 'alpaca2 has no Alpaca key pair of its own, and…',
    }) });
    expect(l.ok).toBe(false);
    expect(l.note).toMatch(/alpaca2 has no Alpaca key pair/);
  });

  test('every account readable passes and names them', () => {
    const l = pf.legJournal({ credentialScope: () => ({
      ids: ['alpaca1', 'alpaca2'], readable: ['alpaca1', 'alpaca2'],
      blind: [], ambiguous: false, reason: null,
    }) });
    expect(l.ok).toBe(true);
    expect(l.note).toMatch(/alpaca1, alpaca2/);
  });

  test('no Alpaca account at all is UNKNOWN, not a pass — there is nothing to '
    + 'read, which is not the same as reading everything', () => {
    const l = pf.legJournal({ credentialScope: () => ({
      ids: [], readable: [], blind: [], ambiguous: false, reason: null,
    }) });
    expect(l.ok).toBeNull();
  });
});

/* ── leg 1: the cards ────────────────────────────────────────────────────── */

describe('the cards', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  let toolsFile;

  beforeAll(() => {
    toolsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-')), 'tools.json');
    fs.writeFileSync(toolsFile, JSON.stringify({
      tools: [{ id: 'T8', name: 'CANSLIM', port: 3070 }],
    }));
  });

  test('a fresh list with names passes', async () => {
    const l = await pf.legCards([okSetup()], {
      toolsFile,
      fetchJson: async () => ({ lastRun: Date.now() - 60000, lastRowCount: 9 }),
    });
    expect(l.ok).toBe(true);
    expect(l.note).toMatch(/9 cards/);
  });

  test('a scan that produced no cards FAILS', async () => {
    const l = await pf.legCards([okSetup()], {
      toolsFile,
      fetchJson: async () => ({ lastRun: Date.now() - 60000, lastRowCount: 0 }),
    });
    expect(l.ok).toBe(false);
    expect(l.note).toMatch(/no cards at all/);
  });

  test('a stale list FAILS and says how old — a card list that stopped '
    + 'updating is how a desk trades a market that has moved', async () => {
    const l = await pf.legCards([okSetup()], {
      toolsFile,
      fetchJson: async () => ({ lastRun: Date.now() - 90 * 60000, lastRowCount: 7 }),
    });
    expect(l.ok).toBe(false);
    expect(l.note).toMatch(/90 minutes old/);
  });

  test('the last scan having failed is a FAILURE that carries the error', async () => {
    const l = await pf.legCards([okSetup()], {
      toolsFile,
      fetchJson: async () => ({ lastRun: Date.now(), lastRowCount: 7,
                                error: 'Cannot convert undefined or null to object' }),
    });
    expect(l.ok).toBe(false);
    expect(l.note).toMatch(/Cannot convert undefined/);
  });

  test('a PAUSED tool is a failure and says so — it is a choice, and still a '
    + 'reason nothing trades', async () => {
    const l = await pf.legCards([okSetup()], {
      toolsFile,
      fetchJson: async () => ({ paused: true, pausedReason: 'by hand', lastRowCount: 7 }),
    });
    expect(l.ok).toBe(false);
    expect(l.note).toMatch(/PAUSED/);
  });

  test('a tool that does not answer is UNKNOWN, never broken', async () => {
    const l = await pf.legCards([okSetup()], {
      toolsFile,
      fetchJson: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(l.ok).toBeNull();
    expect(l.note).toMatch(/did not answer/);
  });

  test('no setup names a tool, so there is nothing to check — UNKNOWN', async () => {
    const l = await pf.legCards([], { toolsFile, fetchJson: async () => ({}) });
    expect(l.ok).toBeNull();
  });
});

/* ── leg 4: the routing ──────────────────────────────────────────────────── */

describe('the routing', () => {
  test('a setup no account takes FAILS, with the reason the runner would give',
    () => {
      const l = pf.legRouting([okSetup()], {
        autoRoute: () => ({ cfgs: [], error: 'no account runs this setup — add '
          + 'it to one on the Settings tab' }),
      });
      expect(l.ok).toBe(false);
      expect(l.note).toMatch(/no account runs this setup/);
    });

  test('a routed setup passes and names the accounts — NOT their configs, '
    + 'which hold each account\'s Alpaca key and secret', () => {
    const l = pf.legRouting([okSetup()], {
      autoRoute: () => ({ cfgs: [
        { destinationId: 'alpaca1', destinationName: 'Alpaca 1',
          alpacaKeyId: 'SECRET', alpacaSecret: 'ALSO SECRET' },
      ], error: null }),
    });
    expect(l.ok).toBe(true);
    expect(l.note).toMatch(/Alpaca 1/);
    expect(JSON.stringify(l)).not.toMatch(/ALSO SECRET/);
    expect(JSON.stringify(l)).not.toMatch(/SECRET/);
  });
});

/* ── nothing leaks ───────────────────────────────────────────────────────── */

test('no hook URL or key reaches the report', async () => {
  const out = await pf.check({ day: '2026-09-03', deps: deps({
    broker: {
      publicSettings: () => ({ destinations: [{
        id: 'alpaca1', name: 'Alpaca 1', enabled: true, hasWebhook: true,
        hasTestWebhook: true, hasAlpacaKeys: true,
      }] }),
      orders: () => [],
      autoRoute: () => ({ cfgs: [{ destinationId: 'alpaca1',
        destinationName: 'Alpaca 1', webhookUrl: 'https://app.signalstack.com/hook/LEAKME',
        alpacaKeyId: 'AKLEAK', alpacaSecret: 'shhh' }], error: null }),
      callbackUrl: () => 'https://x/api/broker/callback/TOKENLEAK',
    },
  }) });
  const json = JSON.stringify(out);
  expect(json).not.toMatch(/LEAKME/);
  expect(json).not.toMatch(/AKLEAK/);
  expect(json).not.toMatch(/shhh/);
  // The callback URL is a credential too — its presence is reported, never it.
  expect(json).not.toMatch(/TOKENLEAK/);
});
