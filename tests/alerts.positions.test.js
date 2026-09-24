/*
 * THE PAGE COUNTED OPEN POSITIONS AND NEVER SHOWED ONE.
 *
 * "3 OPEN NOW" is not a monitor. On a desk whose stops trail an indicator —
 * sent to the broker as a FIXED level that will not follow, so the alert says
 * "manage it yourself" — and whose positions are flattened at 15:50, "what am
 * I holding and what is it doing" is the first question of every afternoon,
 * and nothing on the page answered it.
 *
 * The data was already being fetched. heldNow() asks each readable account for
 * /v2/positions, and the client maps side, avgEntry, current, unrealised and
 * marketValue — then heldNow kept `{symbol, qty, account}` and dropped the
 * rest, one line before it reached the page.
 *
 * THE TWO THINGS THAT MUST NOT RENDER THE SAME:
 *
 *   "you hold nothing"      — checked, and flat
 *   "I could not ask"       — an account did not answer
 *
 * Only one of those is safe to walk away from at 15:49.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'alerts.html'), 'utf8');
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
const reconcile = fs.readFileSync(path.join(ROOT, 'src', 'broker', 'reconcile.js'), 'utf8');

/** paintPositions(), run against a stub DOM, returning what it drew. */
function paint(broker, mgr = null, setups = []) {
  const from = script.indexOf('function paintPositions()');
  if (from < 0) {
    throw new Error('public/alerts.html no longer shows what is held — the page '
      + 'counted open positions and never showed one');
  }
  const to = script.indexOf('\n}', from) + 2;
  const els = {};
  const mk = () => ({ innerHTML: '', textContent: '' });
  const doc = { getElementById: id => (els[id] = els[id] || mk()) };
  // The manager's line is drawn by its own function, lifted beside this one.
  const mfrom = script.indexOf('function posManagerLine(');
  const mline = script.slice(mfrom, script.indexOf('\n}', mfrom) + 2);
  // eslint-disable-next-line no-new-func
  new Function('document', 'BROKER', 'esc', 'tickerLink', 'MGR', 'SETUPS',
    `${mline}\n${script.slice(from, to)}; paintPositions();`)(
    doc, broker,
    s => String(s == null ? '' : s).replace(/</g, '&lt;'),
    // The page's own contract: tickerLink draws `ticker` and nothing else. A
    // stand-in that also accepted `symbol` hid, for weeks, that a broker
    // position (which says `symbol`) was drawn with no name at all.
    p => (p.ticker ? `<span class="t">${p.ticker}</span>` : ''), mgr, setups);
  return { out: els.positions.innerHTML, note: els['pos-note'].textContent };
}

const POS = (over = {}) => ({
  symbol: 'VEEV', qty: 195, account: 'alpaca2', side: 'long',
  avgEntry: 263, current: 260.81, unrealised: -427.05, marketValue: 50858, ...over,
});

describe('the account keeps the numbers, not the ledger', () => {
  test('heldNow carries the whole position through', () => {
    /*
     * It kept symbol/qty/account because its only caller counted rows. The
     * entry, the last price and the open P&L were fetched from Alpaca on every
     * sweep and thrown away one line before the page could have them.
     */
    const fn = reconcile.slice(reconcile.indexOf('for (const p of r.positions)'),
                               reconcile.indexOf('if (!anyOk)'));
    for (const f of ['side', 'avgEntry', 'current', 'unrealised', 'marketValue']) {
      expect({ field: f, carried: fn.includes(f) }).toEqual({ field: f, carried: true });
    }
  });
});

describe('what is held', () => {
  test('a position shows entry, now and the open P&L', () => {
    const { out } = paint({ held: { ok: true, positions: [POS()] } });
    expect(out).toContain('VEEV');
    expect(out).toContain('263.00');        // entry
    expect(out).toContain('260.81');        // now
    expect(out).toContain('195 sh');
    expect(out).toContain('alpaca2');       // WHICH account holds it
  });

  test('a loss is red and a gain is green, and the sign is right', () => {
    const down = paint({ held: { ok: true, positions: [POS()] } }).out;
    expect(down).toContain('class="when bad"');
    expect(down).toContain('-$427');
    const up = paint({ held: { ok: true,
      positions: [POS({ current: 266, unrealised: 585 })] } }).out;
    expect(up).toContain('class="when ok"');
    expect(up).toContain('+$585');
  });

  test('a SHORT is marked short and its percent is not inverted', () => {
    /*
     * A short that has fallen is a short in PROFIT. Reading the raw price move
     * would paint it as the loss it is not, on the one row that exists to say
     * how much trouble you are in.
     */
    const { out } = paint({ held: { ok: true, positions: [POS({
      side: 'short', qty: -195, avgEntry: 263, current: 260,
      unrealised: 585 })] } });
    expect(out).toContain('>SHORT<');
    expect(out).toContain('su-tag sell');
    // (263-260)/263 = +1.14% for a short.
    expect(out).toMatch(/\+1\.1\d%/);
    // …and the share count is printed as a size, not as a negative number.
    expect(out).toContain('195 sh');
    expect(out).not.toContain('-195 sh');
  });

  test('the worst one is first', () => {
    // The biggest loser is the row you want without scrolling.
    const { out } = paint({ held: { ok: true, positions: [
      POS({ symbol: 'AAA', unrealised: 100 }),
      POS({ symbol: 'BBB', unrealised: -900 }),
      POS({ symbol: 'CCC', unrealised: -50 }),
    ] } });
    expect(out.indexOf('BBB')).toBeLessThan(out.indexOf('CCC'));
    expect(out.indexOf('CCC')).toBeLessThan(out.indexOf('AAA'));
  });

  test('the heading totals the open money', () => {
    const { note } = paint({ held: { ok: true, positions: [
      POS({ unrealised: -900 }), POS({ unrealised: 400 }),
    ] } });
    expect(note).toContain('2 positions');
    expect(note).toContain('-$500');
  });
});

describe('flat and blind do not look the same', () => {
  test('checked and flat says FLAT', () => {
    const { out, note } = paint({ held: { ok: true, positions: [] } });
    expect(out).toContain('Flat');
    expect(out).toContain('No position open');
    expect(note).toContain('checked at the broker');
  });

  test('an account that did not answer says so, with its reason', () => {
    /*
     * AN ERROR IS NEVER A ZERO. An empty list here reads as "you are flat",
     * and acting on that at 15:49 is a position held overnight.
     */
    const { out } = paint({ held: { ok: false, verifiable: true,
      reason: 'alpaca1: 401 unauthorized', positions: null } });
    expect(out).toContain('Not verified');
    expect(out).toContain('alpaca1: 401 unauthorized');
    expect(out).toContain('not "you hold nothing"');
    expect(out).not.toContain('Flat');
  });

  test('before the broker has answered at all', () => {
    for (const b of [null, {}, { held: null }]) {
      const { out } = paint(b);
      expect({ b: JSON.stringify(b), says: out.includes('Not verified') })
        .toEqual({ b: JSON.stringify(b), says: true });
    }
  });
});

test('the count in the strip and the list below it are the same answer', () => {
  /*
   * Both are painted from BROKER.held, in the same function, on the same tick.
   * Two sources would be two numbers that can disagree about whether anything
   * is open — which is what the page already had once, between the ledger's
   * committed dollars and the account's positions.
   */
  const fn = script.slice(script.indexOf('function paintAlgoState()'),
                          script.indexOf('\n}', script.indexOf('function paintAlgoState()')));
  expect(fn).toContain('paintStrip()');
  expect(fn).toContain('paintPositions()');
  expect(script).toContain('const held = (BROKER && BROKER.held) || null;');
});


/*
 * THE MANAGER'S HALF OF THE PICTURE. The broker knows what is held; only the
 * manager knows where the stop is NOW and whether 09:35's 2R half has banked.
 * Asked for as "Live should be a live monitor screen for me, the trader".
 */
describe('each position says what the manager is doing with it', () => {
  const held = { held: { ok: true, positions: [POS()] } };
  const pass = (x) => ({ at: Date.now() - 20000, positions: [{ symbol: 'VEEV', setupId: 'OR@09:35',
    stop: 258.5, barsHeld: 23, ...x }] });
  test('stop, time held, the setup, and how fresh the check is', () => {
    const { out } = paint(held, pass({ stopMoved: true, waitingFor: 'first target leg' }),
                          [{ id: 'OR@09:35', name: 'OR + VWAP 09:35' }]);
    expect(out).toMatch(/stop <b>258.50<\/b> ↑moved · waiting for first target leg · 23 min · OR \+ VWAP 09:35 · checked 20s ago/);
  });
  test('after the 2R half banks, it says so', () => {
    const { out } = paint(held, pass({ legsBanked: 1 }));
    expect(out).toMatch(/✓ 1 target leg taken<\/span> · rest leaves on the exit rule/);
  });
  test('no manager record for the symbol draws no line, not a guess', () => {
    const { out } = paint(held, { at: Date.now(), positions: [{ symbol: 'OTHER' }] });
    expect(out).not.toMatch(/pos-mgr/);
  });
});

test('THE CARD NAMES THE STOCK — a broker position says symbol, not ticker', () => {
  const { out } = paint({ held: { ok: true, positions: [POS()] } });
  expect(out).toMatch(/<span class="t">VEEV<\/span>/);
});
