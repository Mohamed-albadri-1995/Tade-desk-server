/*
 * "the Algo desk must get feedback from alpaca for orders confirmation"
 *
 * It could not, and the reason was not a missing feature.
 *
 * `reconcile.confirmed()` has been correct since it was written: it splits the
 * day's rows by the destination that placed them and matches each group only
 * against fills fetched with THAT account's credentials, so one account's
 * print can never confirm another's order. It carries its own note explaining
 * why that matters.
 *
 * NOTHING CALLED IT. A grep for `confirmed(` across src/ returned the
 * definition and nothing else. So the desk sent orders through SignalStack all
 * day and never once asked the broker whether they existed — which is the
 * fourth failure named in reconcile.js's own opening comment:
 *
 *     SENT, AND ALPACA HAS NO RECORD   SignalStack accepted it and the broker
 *                                      never got it. The alert said the trade
 *                                      was on.
 *
 * A function that is right and unreferenced has never been right about
 * anything.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'alerts', 'server.js'), 'utf8');
const RECONCILE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'broker', 'reconcile.js'), 'utf8');

/** Comment prose, normalised the way a person reads it. */
const flat = (s) => s.replace(/\s*\*\s*/g, ' ').replace(/\s+/g, ' ');

/*
 * The route AND the comment block that documents it. Slicing from `app.get(`
 * alone cuts the doc off — and the doc is where the reasoning lives, so a test
 * that reads only the body cannot check any of it.
 */
function confirmRegion() {
  const at = SRC.indexOf("app.get('/api/broker/confirm'");
  const doc = SRC.lastIndexOf('/*', at);
  return SRC.slice(doc, SRC.indexOf('app.get(', at + 10));
}

describe('the desk asks Alpaca whether its orders landed', () => {
  test('confirmed() is actually called by something now', () => {
    expect(SRC).toContain('reconcile.confirmed(');
  });

  test('it is reachable as a route on the desk', () => {
    expect(SRC).toContain("app.get('/api/broker/confirm'");
  });

  /*
   * READ-ONLY. It reads the day's rows and the day's fills and says which
   * match. A confirmation that could act — re-send, cancel, flatten — would
   * need to be right about a great deal more than this is.
   */
  test('it sends nothing and changes nothing', () => {
    const body = confirmRegion();
    expect(body).not.toMatch(/placeOrder|sendOrder|post\(|flatten/i);
    expect(flat(body)).toContain('READ-ONLY');
  });

  /*
   * ONLY ORDERS THAT COULD BE CONFIRMED ARE COUNTED. TTP5k is behind
   * TraderEvolution with no fill feed, so a TTP order has no print to match
   * and never will. Counting it as unmatched would report a permanent failure
   * on an account that is working, every day, and the number would stop being
   * read — which is the same fault as the [warn] that fired on success.
   */
  test('orders to accounts with no fill feed are excluded, not failed', () => {
    const body = confirmRegion();
    expect(body).toContain('alpacaDestinations()');
    expect(body).toContain('notAskable');
    expect(flat(body)).toContain('no fill feed');
  });

  /*
   * TWO KINDS OF CONFIRMATION, AND THEY ARE NOT THE SAME EVIDENCE. The
   * SignalStack callback saying "filled" is a claim by the thing that
   * forwarded the order; Alpaca's own fills are the account. Merging them
   * would make asking Alpaca pointless, which is what was asked for.
   */
  test('a callback confirmation is counted apart from a fill confirmation', () => {
    const body = confirmRegion();
    expect(body).toContain("confirmedBy === 'alpaca'");
    expect(body).toContain('callbackOnly');
  });

  test('the unmatched orders are named, not just counted', () => {
    const body = confirmRegion();
    expect(body).toMatch(/unmatched:\s*unmatched\.map/);
    expect(body).toContain('symbol');
    expect(body).toContain('destination');
  });

  test('a failure answers 200 with ok:false, not a 500', () => {
    // A 500 reads on the page as "no orders", which is the opposite of what it
    // means — the same contract /api/broker/fills already keeps.
    const body = confirmRegion();
    expect(body).toContain('res.json({ ok: false, error: err.message })');
  });

  test('the per-account rule it depends on is still stated where it lives', () => {
    // If confirmed() ever pooled accounts, this endpoint would confirm one
    // account's order with the other's print and look perfect doing it.
    expect(flat(RECONCILE)).toContain('ONE ACCOUNT AT A TIME, EACH AGAINST ITS OWN FILLS');
  });

  test('the request that prompted it is recorded', () => {
    expect(flat(SRC)).toContain('feedback from alpaca for orders confirmation');
  });
});
