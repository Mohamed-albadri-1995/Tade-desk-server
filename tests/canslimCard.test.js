/*
 * C, A AND N ON THE CARD ITSELF.
 *
 * S, L and M were already card rows. C, A and N were not — they lived only
 * behind the CANSLIM ⤢ panel, because an eight-quarter table needs a
 * full-width surface. But the TABLE needing width does not mean the READING
 * does: "EPS +48%, sales +65%, accelerating" is one line, and it is the line
 * that decides whether the card is worth opening at all.
 *
 * This drives the REAL function against the REAL backend payload shape. A
 * grep for a class name would pass on a renamed field and print "undefined of
 * undefined" on every card — which is exactly what `beats` vs `beat_25` did
 * before this test existed.
 */

const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

function lift() {
  const grab = (re, what) => {
    const m = page.match(re);
    if (!m) throw new Error(`${what} not found in public/index.html — was it renamed?`);
    return m[0];
  };
  const src = [
    grab(/function canslimCardBlock\(ticker\) \{[\s\S]*?\n\}/, 'canslimCardBlock()'),
    grab(/const DEFS = \{[\s\S]*?\n\};/, 'DEFS'),
  ].join('\n');
  // The two helpers the block calls. Stubbed rather than lifted: `info` opens
  // a definition card and `esc` escapes HTML, and neither is what is under
  // test here — but `info` is stubbed to EMIT ITS KEY so the test can still
  // assert that each row is wired to a definition.
  // eslint-disable-next-line no-new-func
  return new Function(`
    const info = k => '[[def:' + k + ']]';
    const esc = s => String(s == null ? '' : s);
    let CANSLIM_PANEL = { fundamentals: {}, bases: {} };
    ${src}
    return { canslimCardBlock, CANSLIM_PANEL, DEFS };
  `)();
}

const { canslimCardBlock, CANSLIM_PANEL, DEFS } = lift();

const FULL = {
  ok: true,
  c: {
    rows: [{
      quarter: '2026-06-30',
      eps_chg: 48.3, eps_chg_label: '+48.3%',
      sales_chg: 65.5, sales_chg_label: '+65.5%',
    }],
    accelerating: true, accelerating_of: 3,
    bar_pct: 25, beat_25: 4, beat_25_of: 7,
  },
  a: {
    rows: [{ fy: '2025-12-31', eps: 4.6 }],
    growth_3yr_pct: 42, stability: 12,
    roe_pct: 31.5, roe_floor: 17, roe_pass: true,
  },
};

const BASE = {
  ok: true, weeks: 27, depth_pct: 44.6,
  handle: { valid: true, weeks: 3, depth_pct: 8.1 },
  pivot: 323.61, pct_to_pivot: 4.2, score: 5, of: 6,
};

const put = (tk, f, b) => {
  CANSLIM_PANEL.fundamentals[tk] = f;
  CANSLIM_PANEL.bases[tk] = b;
  return canslimCardBlock(tk);
};

describe('the C, A and N rows on the card', () => {
  const html = put('TEST', FULL, BASE);

  test('C shows EPS AND SALES together, never EPS alone', () => {
    // A buyback lifts EPS with the business standing still. Only the pair
    // separates the two, so one without the other is not a shorter version of
    // this row — it is a different and misleading claim.
    expect(html).toContain('+48.3%');
    expect(html).toContain('+65.5%');
  });

  test('C carries the acceleration reading, not just the raw percentages', () => {
    expect(html).toMatch(/accelerating/);
    expect(html).toContain('4 of 7');
  });

  test('A shows the 3-year rate, the wobble and the ROE against its floor', () => {
    expect(html).toContain('42%');
    expect(html).toContain('31.5%');
    expect(html).toContain('17%');
  });

  test('the wobble still says LOW IS GOOD — the one inverted number here', () => {
    // Every other figure on the card is better when larger. Printing this one
    // bare invites it to be read the same way.
    expect(html).toMatch(/low is good/i);
  });

  test('N shows the pivot, the distance to it, and the checks', () => {
    expect(html).toContain('323.61');
    expect(html).toContain('4.2% away');
    expect(html).toContain('5 of 6');
  });

  test('N is LABELLED WEEKLY on the card, not only inside the panel', () => {
    // The same tests on daily bars measure something else, and the card is
    // where that gets forgotten.
    expect(html).toMatch(/weekly/i);
    expect(html).toContain('27w');
  });

  test('no field renders as undefined — a renamed backend key must fail here', () => {
    expect(html).not.toMatch(/undefined|NaN/);
  });

  test('every row is wired to a definition card', () => {
    for (const k of ['canslim_c', 'canslim_a', 'canslim_n']) {
      expect(html).toContain(`[[def:${k}]]`);
    }
  });
});

describe('the colouring follows the reading, not the sign', () => {
  test('a quarter clearing the +25% bar is bullish, a fall is bearish', () => {
    const up = put('UP', FULL, BASE);
    expect(up).toMatch(/bias-bull">EPS \+48\.3%/);
    const down = JSON.parse(JSON.stringify(FULL));
    down.c.rows[0].eps_chg = -28;
    down.c.rows[0].eps_chg_label = '-28.0%';
    expect(put('DOWN', down, BASE)).toMatch(/bias-bear">EPS -28\.0%/);
  });

  test('a LOW wobble is the bullish one', () => {
    const steady = put('STEADY', FULL, BASE);
    expect(steady).toMatch(/bias-bull">wobble 12/);
    const wild = JSON.parse(JSON.stringify(FULL));
    wild.a.stability = 88;
    expect(put('WILD', wild, BASE)).toMatch(/bias-bear">wobble 88/);
  });

  test('a pivot within reach is bullish, one far above is not', () => {
    expect(put('NEAR', FULL, BASE)).toMatch(/bias-bull">4\.2% away/);
    const far = { ...BASE, pct_to_pivot: 70.2 };
    expect(put('FAR', FULL, far)).toMatch(/bias-bear">70\.2% away/);
  });
});

describe('missing data is a normal answer, not a broken card', () => {
  test('a stock with no filings drops the C and A rows silently', () => {
    const h = put('NONE', { ok: false, error: 'no filings cached' },
                  { ok: false, reason: 'no weekly base yet' });
    expect(h).not.toContain('EPS');
    expect(h).not.toMatch(/undefined/);
  });

  test('...but a missing BASE says so, because "no base" is itself a reading', () => {
    const h = put('NONE2', { ok: false, error: 'x' },
                  { ok: false, reason: 'no weekly base yet' });
    expect(h).toContain('no weekly base yet');
  });

  test('a ticker never fetched renders nothing at all', () => {
    // Not "—", not a spinner. The row appears when the batch comes back.
    expect(canslimCardBlock('NEVERASKED')).toBe('');
  });

  test('a null growth rate or ROE prints an em dash, never "null"', () => {
    const thin = JSON.parse(JSON.stringify(FULL));
    thin.a.growth_3yr_pct = null;
    thin.a.stability = null;
    thin.a.roe_pct = null;
    thin.a.roe_pass = null;
    const h = put('THIN', thin, BASE);
    expect(h).toContain('—');
    expect(h).not.toMatch(/null|undefined/);
  });
});

describe('every new number explains itself in the tool', () => {
  // Section 13: the card is locked, and the way anything gets added to it is
  // a definition card with all four parts. `title=` does not exist on a touch
  // screen, which is why these are tap-to-open rather than hover text.
  for (const k of ['canslim_c', 'canslim_a', 'canslim_n']) {
    test(`${k} has what / how / WHAT IT IS NOT / source`, () => {
      const d = DEFS[k];
      expect(d).toBeTruthy();
      expect(d.title).toBeTruthy();
      expect(d.what).toBeTruthy();
      expect(d.how).toBeTruthy();
      expect(d.not).toBeTruthy();
      expect(d.src).toBeTruthy();
    });
  }

  test('N says in so many words that it is NOT a daily reading', () => {
    expect(DEFS.canslim_n.not).toMatch(/NOT A DAILY/i);
  });

  test('C says the year-ago base, not the previous quarter', () => {
    expect(DEFS.canslim_c.what).toMatch(/one year earlier/i);
  });
});

describe('the card fetches once for the whole screen, never per card', () => {
  // X5. A block that fetched inside its own render would make one request per
  // card and 150 of them on a full scan.
  test('canslimCardBlock is pure — it reads the cache and returns a string', () => {
    expect(String(canslimCardBlock)).not.toMatch(/fetch\(|await /);
  });

  test('the batch loader is joined to the existing one-pass prefetch', () => {
    expect(page).toMatch(/loadCanslimFacts\(needF\)/);
    expect(page).toMatch(/async function loadCanslimFacts/);
  });

  test('a ticker EDGAR has nothing for is still marked as asked', () => {
    // Otherwise every re-render queues it again, forever.
    const m = page.match(/async function loadCanslimFacts[\s\S]*?\n\}/)[0];
    expect(m).toMatch(/must still be marked as asked/);
    expect(m).toMatch(/CANSLIM_PANEL\.fundamentals\[t\] = \{ ok: false/);
  });
});

describe('the card reads in letter order', () => {
  // The order IS the method: C and A say whether the company is worth owning,
  // N whether the chart is ready, S L I who else is in it, M whether now is
  // the time. Scattered, it is a different checklist.
  test('C A N, then S, then L, then M', () => {
    const body = page.match(
      /section-title">Market Context<\/div>[\s\S]*?ctx-label">Regime/)[0];
    expect(body.indexOf('canslimCardBlock')).toBeGreaterThan(-1);
    expect(body.indexOf('canslimCardBlock'))
      .toBeLessThan(body.indexOf('ratingsCardBlock'));
    expect(body.indexOf('ratingsCardBlock'))
      .toBeLessThan(body.indexOf('groupCardBlock'));
    expect(body.indexOf('groupCardBlock'))
      .toBeLessThan(body.indexOf('oneilCardBlock'));
  });
});
