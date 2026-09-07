/*
 * A RESTART MUST NOT BLIND THE DESK.
 *
 * r0 — the card list every setup ranks — is an in-memory Map
 * (src/r0/registry.js). A restart empties it, and nothing refilled it until
 * the next cron tick. Between 10:00 and 16:00 that is every FIFTEEN MINUTES.
 *
 * So every deploy taken during the session left all six tools with no cards
 * for up to a quarter of an hour, and any setup deciding inside that gap
 * published
 *
 *     "No cards on the list at the decision — nothing to rank."
 *
 * which reads as a quiet market and is nothing of the kind. It is the desk
 * having been restarted.
 *
 * Measured on 2026-09-08: a deploy at 11:22, and three minutes later every
 * tool reported `last scan not yet · 0 cards` while the same screeners,
 * probed directly, matched 13, 10, 4 and 3 names. The cards existed. The
 * tools had simply been told to forget them and not to look again for a
 * quarter of an hour.
 *
 * A week of deploying during market hours is a week of that.
 */

const { scanningNow } = require('../src/scheduler');

/* A time in New York, whatever this machine's clock is set to. */
const et = (s) => Date.parse(`${s}-04:00`);   // 2026-09 is EDT

describe('the tool scans as soon as it comes up, if the market is open', () => {
  test('inside the discovery span it is scanning', () => {
    for (const t of ['2026-09-08T04:00', '2026-09-08T09:35', '2026-09-08T15:59']) {
      expect({ t, scan: scanningNow(et(t)) }).toEqual({ t, scan: true });
    }
  });

  /*
   * THE SAME SPAN THE CRON COVERS, so a startup scan can never ask
   * TradingView something the schedule would not have asked minutes later.
   * 04:00 is the first discovery job; 16:00 is the close capture.
   */
  test('before it opens and after it shuts it is not', () => {
    for (const t of ['2026-09-08T03:59', '2026-09-08T16:00', '2026-09-08T23:30']) {
      expect({ t, scan: scanningNow(et(t)) }).toEqual({ t, scan: false });
    }
  });

  test('a weekend is never scanning, however good the hour', () => {
    // 2026-09-05 is a Saturday, 09-06 a Sunday.
    expect(scanningNow(et('2026-09-05T09:35'))).toBe(false);
    expect(scanningNow(et('2026-09-06T09:35'))).toBe(false);
    // …and the weekday either side of it is.
    expect(scanningNow(et('2026-09-04T09:35'))).toBe(true);
    expect(scanningNow(et('2026-09-07T09:35'))).toBe(true);
  });
});

describe('and it can neither delay startup nor bring the process down', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'scheduler.js'), 'utf8');

  /*
   * NOT AWAITED. The tool has to answer /health and serve its pages whether
   * or not TradingView is reachable this second — the deploy's own health
   * check runs seconds after the process starts, and a startup that waited on
   * a scan would fail it and be reported as a tool that would not come up.
   */
  test('the scan is fired, not awaited', () => {
    expect(src).toMatch(/\.then\(\(\) => runFullScan\(\)\)/);
    expect(src).not.toMatch(/await runFullScan\(\);\s*\n\s*\/\/ ── discovery/);
  });

  test('a failure is logged and swallowed — the cron still owns the schedule', () => {
    expect(src).toMatch(/catch\(err => console\.warn\('\[Scheduler\] the startup scan failed/);
    expect(src).toMatch(/next\s+\n?\s*\*?\s*'?\s*\+?\s*'?scheduled scan will refill the list/);
  });

  test('it is gated on the hours, and says so when it skips', () => {
    expect(src).toMatch(/if \(scanningNow\(\)\) \{/);
    expect(src).toMatch(/outside 04:00–16:00 ET — no startup scan/);
  });

  /*
   * WHY THIS IS NOT "JUST PERSIST r0". Persisting the map would bring back
   * YESTERDAY's cards on a morning restart, and a stale card is worse than no
   * card: it looks like a live candidate. Re-scanning asks the question again
   * and gets today's answer.
   */
  test('the reason is written down where the code is', () => {
    expect(src).toMatch(/r0 IS AN IN-MEMORY MAP/);
    expect(src).toMatch(/every FIFTEEN MINUTES/);
    expect(src).toMatch(/No cards on the list at the decision/);
  });
});
