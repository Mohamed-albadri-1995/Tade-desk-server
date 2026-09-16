/*
 * THE PRICE THE DECISION WAS TAKEN AT, so slippage can be measured at all.
 *
 * Every journal card the desk placed ended with the same three characters:
 *
 *   Alpaca (alpaca1) — bought 1096 @ 35.73 · sold 1096 @ 35.86
 *                      · realised +142.48 · vs 35.86 planned: +0.00
 *
 * +0.00. On every card. Every day. Whatever happened.
 *
 * Because "planned" was the JOURNAL's entry price, and the journal's entry
 * price is computed FROM the Alpaca fill — src/broker/journalTrades.js:
 *
 *     const entryPrice = t.entryQty ? t.entryCost / t.entryQty : null;
 *
 * So the line compared the fill against itself. The desk had decided BLSH at
 * 36.03 and filled at 35.86: seventeen cents, reported as zero by the one
 * field whose entire job is to report it.
 *
 * WHY THIS ONE MATTERS MORE THAN THE OTHERS. The trader's acceptance test for
 * this whole project is that live and the backtest produce the same trades,
 * "with just acceptable miss matching — for me the execution delay is the only
 * reason I will accept". Execution delay is the one permitted difference, and
 * nothing on the desk could measure it.
 *
 * The number was never missing. `placeOrder` is given pick.plan.entry — the
 * decision bar's close — and writes it to the ledger as `price`. It simply was
 * not carried out to anything that could compare it.
 *
 * Fifth instance of the same fault: `source: 'end of session'`, `No 09:29 bar`,
 * the unnamed quiet setup, `account.base`, and now this. A field that says the
 * same thing whatever happened.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'planned-price-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');

const broker = require('../src/broker/signalstack');

const DAY = '2026-09-15';

/** One ledger row, as the order path writes it. */
function row(over = {}) {
  const o = { at: 1000, date: DAY, symbol: 'BLSH', setupId: 'or-vwap-0935',
              signal: 'SHORT', sent: true, destination: 'alpaca1',
              quantity: 1836, price: 36.03, stop: 36.275,
              decisionBar: '09:34', ...over };
  fs.appendFileSync(process.env.BROKER_LEDGER, `${JSON.stringify(o)}\n`);
  return o;
}

beforeEach(() => { fs.rmSync(process.env.BROKER_LEDGER, { force: true }); });

describe('the desk carries the price it decided at', () => {
  test('the decided price reaches the caller', () => {
    row();
    expect(broker.setupBySymbol(DAY).BLSH.planned).toBe(36.03);
  });

  /*
   * AND THE STOP WITH IT. Seventeen cents means nothing until you know the
   * stop was twenty-four away — that is two thirds of the trade's risk. The
   * same seventeen cents against a $2 stop is noise.
   */
  test('the stop comes with it, so the slip can be read in R', () => {
    row();
    const g = broker.setupBySymbol(DAY).BLSH;
    expect(g.plannedStop).toBe(36.275);
    // the real 2026-09-15 numbers: decided 36.03, filled 35.86, on a 0.245 stop
    // SHORT: filling BELOW the price you decided to short at is worse, so the
    // sign convention is "+ is worse, either way" — the same one the card uses.
    const slip = -(35.86 - g.planned);
    expect(Number(slip.toFixed(2))).toBe(0.17);
    expect(Number((slip / Math.abs(g.planned - g.plannedStop)).toFixed(2))).toBe(0.69);
  });

  test('and the bar it was decided on', () => {
    row();
    expect(broker.setupBySymbol(DAY).BLSH.decisionBar).toBe('09:34');
  });

  /*
   * NULL, NOT ZERO, when the row has no price. A ledger line written before
   * this field existed has none, and a planned price of 0 would render as a
   * slip the size of the whole share price.
   */
  test('a row with no price reports null rather than zero', () => {
    row({ price: undefined });
    expect(broker.setupBySymbol(DAY).BLSH.planned).toBeNull();
  });

  test('and a price that is not a number is null too', () => {
    row({ price: 'n/a' });
    expect(broker.setupBySymbol(DAY).BLSH.planned).toBeNull();
  });

  /*
   * NULL IS NOT ZERO, and Number(null) is 0. A row written before `stop`
   * existed would otherwise report a stop of $0.00 — an R multiple measured
   * against a stop the whole way to zero.
   */
  test('a missing stop is null, and never zero', () => {
    row({ stop: null });
    const g = broker.setupBySymbol(DAY).BLSH;
    expect(g.plannedStop).toBeNull();
    expect(g.planned).toBe(36.03);
  });
});

/* ── which row owns the price when there are several ──────────────────────── */

describe('the earliest send is the entry, and it owns the price', () => {
  /*
   * TWO ACCOUNTS, ONE SIGNAL. Both are sent at the decided price, so this
   * normally changes nothing — the assertion is that it stays stable rather
   * than taking whichever line happened to be written last.
   */
  test('a second account does not move the decided price', () => {
    row({ at: 1000, price: 36.03, destination: 'alpaca1' });
    row({ at: 2000, price: 36.03, destination: 'alpaca2' });
    expect(broker.setupBySymbol(DAY).BLSH.planned).toBe(36.03);
  });

  test('a later row at a different price does not win', () => {
    row({ at: 1000, price: 36.03 });
    row({ at: 5000, price: 35.10 });
    expect(broker.setupBySymbol(DAY).BLSH.planned).toBe(36.03);
  });

  /*
   * AND AN EARLIER ONE DOES — rows are not guaranteed to arrive in time order,
   * and the entry is the first decision whichever line the file holds first.
   */
  test('an earlier row arriving second replaces it', () => {
    row({ at: 5000, price: 35.10, stop: 35.50, decisionBar: '10:04' });
    row({ at: 1000, price: 36.03, stop: 36.275, decisionBar: '09:34' });
    const g = broker.setupBySymbol(DAY).BLSH;
    expect(g.planned).toBe(36.03);
    expect(g.at).toBe(1000);
  });

  /*
   * THE PRICE AND THE TIME DESCRIBE THE SAME ROW. They move together, so a
   * card can never show one row's bar beside another row's price.
   */
  test('the price, the stop and the bar all move with `at`', () => {
    row({ at: 5000, price: 35.10, stop: 35.50, decisionBar: '10:04' });
    row({ at: 1000, price: 36.03, stop: 36.275, decisionBar: '09:34' });
    const g = broker.setupBySymbol(DAY).BLSH;
    expect(g).toMatchObject({ at: 1000, planned: 36.03, plannedStop: 36.275,
                              decisionBar: '09:34' });
  });
});

/* ── nothing else about the row changed ───────────────────────────────────── */

describe('what setupBySymbol already answered, it still answers', () => {
  test('the name, the setup and the side', () => {
    row();
    expect(broker.setupBySymbol(DAY).BLSH).toMatchObject({
      symbol: 'BLSH', setupId: 'or-vwap-0935', side: 'short', ambiguous: false,
    });
  });

  /*
   * TWO SETUPS ON ONE NAME STILL STOPS IT. A wrong tag is worse than no tag,
   * and adding fields must not have loosened that.
   */
  test('two setups on one name is still ambiguous and untagged', () => {
    row({ at: 1000, setupId: 'or-vwap-0935' });
    row({ at: 2000, setupId: 'test-0930' });
    const g = broker.setupBySymbol(DAY).BLSH;
    expect(g.ambiguous).toBe(true);
    expect(g.setupId).toBeNull();
  });

  test('a refused order is not a decision and contributes nothing', () => {
    row({ sent: false });
    expect(broker.setupBySymbol(DAY).BLSH).toBeUndefined();
  });

  test('a flatten is not an entry either', () => {
    row({ kind: 'flatten' });
    expect(broker.setupBySymbol(DAY).BLSH).toBeUndefined();
  });
});

/* ── and the card reads the desk's number, not the journal's ─────────────── */

/*
 * The page half is asserted on its source, the way this repo's other page
 * tests are — jsdom is not a dependency here and adding one would have to be
 * installed on the box to deploy. What is checked is the SUBSTITUTION: the
 * comparison must start from the desk's row, and fall back to the journal's
 * entry only when the desk did not place the trade.
 */
describe('the journal card compares against the decided price', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'journal', 'patch.js'), 'utf8');

  test('the planned price comes from the desk row when there is one', () => {
    expect(SRC).toMatch(/var planned = desk && desk\.planned > 0 \? Number\(desk\.planned\) : null;/);
    expect(SRC).toMatch(/var want = planned != null \? planned : Number\(t\.entryPrice\);/);
  });

  /*
   * A HAND-TYPED TRADE KEEPS ITS OWN. There the journal's entry really is what
   * was intended — typed by a person before any fill existed — so the
   * comparison is real and must not be thrown away.
   */
  test('a trade the desk did not place still uses the journal entry', () => {
    expect(SRC).toMatch(/: Number\(t\.entryPrice\)/);
  });

  /*
   * AND THE CARD SAYS WHICH. Two numbers with the same label and different
   * provenance is exactly how this went wrong in the first place.
   */
  test('the line says whether the price was decided or merely planned', () => {
    expect(SRC).toMatch(/var origin = planned != null \? 'decided' : 'planned';/);
  });

  test('the slip is shown in R when the stop is known', () => {
    expect(SRC).toMatch(/slip \/ Math\.abs\(want - stop\)/);
  });

  test('the desk row is fetched from the cache, not per card', () => {
    expect(SRC).toMatch(/deskSetupsFor\(t\.date\)\.then\(function \(bySym\)/);
  });
});
