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
    const m = page.match(/async function _canslimPart[\s\S]*?\n\}/)[0];
    expect(m).toMatch(/must still be marked as asked/);
    expect(m).toMatch(/CANSLIM_PANEL\[into\]\[t\] = blank/);
  });

  /*
   * THE CARD PREFETCH READS EDGAR'S CACHE AND NEVER WALKS IT.
   *
   * The first version walked it: 25 cold tickers inside one request, so the
   * page waited on the slowest source before drawing anything AND the burst
   * got the news feed's EDGAR source rate-limited — every card in that scan
   * printed "edgar not answering". The panel, one symbol and a deliberate
   * tap, is the only path allowed to build.
   */
  test('the card prefetch asks for cached EDGAR data only', () => {
    const m = page.match(/async function _canslimPart[\s\S]*?\n\}/)[0];
    expect(m).toContain('cards=1');
  });

  test('...and something still FILLS that cache, in the background', () => {
    // While C and A lived behind a popup, that popup was the only thing that
    // ever walked EDGAR. Moving them onto the card removed that path, and a
    // cache nothing fills is an empty cache — every card would have read
    // "not fetched yet" forever.
    const oneil = fs.readFileSync(
      path.join(__dirname, '../src/sideD/oneil.js'), 'utf8');
    expect(oneil).toContain('function warmFundamentals');
    const route = fs.readFileSync(
      path.join(__dirname, '../src/routes/market.js'), 'utf8');
    expect(route).toContain('oneil.warmFundamentals(symbols)');
    // NOT awaited — the response must not wait on EDGAR.
    expect(route).not.toMatch(/await oneil\.warmFundamentals/);
  });

  test('the base and the filings are asked for separately', () => {
    // The base comes from price bars and answers in a moment; C and A come
    // from filings. Asked together, N waited on EDGAR for no reason.
    const m = page.match(/async function loadCanslimFacts[\s\S]*?\n\}/)[0];
    expect(m).toMatch(/'fundamentals'/);
    expect(m).toMatch(/'bases'/);
    expect(page).toMatch(/parts=' \+ part/);
  });
});

describe('the card has sections, not one flat list', () => {
  /*
   * The seven letters and the desk's own regime rows shared one heading, so
   * the card was a long column where nothing said which system a line
   * belonged to. Each section is now a fold with a one-line summary, and
   * CANSLIM has its own.
   */
  const sec = page.match(
    /const rows = canslimCardBlock[\s\S]*?return fold\('canslim',/)[0];

  test('CANSLIM is its own titled section', () => {
    expect(page).toContain("fold('canslim', \"CANSLIM · O'Neil\"");
  });

  test('the letters run C A N, then S, then L, then M inside it', () => {
    // The order IS the method: C and A say whether the company is worth
    // owning, N whether the chart is ready, S and L who else is in it, M
    // whether now is the time.
    expect(sec.indexOf('canslimCardBlock'))
      .toBeLessThan(sec.indexOf('ratingsCardBlock'));
    expect(sec.indexOf('ratingsCardBlock'))
      .toBeLessThan(sec.indexOf('groupCardBlock'));
    expect(sec.indexOf('groupCardBlock'))
      .toBeLessThan(sec.indexOf('oneilCardBlock'));
  });

  test('the RS line and divergence are NOT filed under a letter', () => {
    // They are phase-4 strength reads, not a CANSLIM letter, and putting them
    // under one would be a claim about what O'Neil's method contains.
    expect(sec).toContain('Relative strength');
    expect(sec).toContain('strengthCardBlock');
    expect(sec.indexOf('Relative strength'))
      .toBeGreaterThan(sec.indexOf('cl-pending'));
  });

  test("the desk's own regime rows are a separate section", () => {
    const desk = page.match(
      /fold\('context', 'Market Context'[\s\S]*?ctx-label">Bias/)[0];
    expect(desk).not.toContain('canslimCardBlock');
    expect(desk).not.toContain('oneilCardBlock');
    expect(desk).toContain('ctx-label">Regime');
  });

  test('every letter row is prefixed with its letter', () => {
    const html = put('LETTERS', FULL, BASE);
    expect(html).toContain('cl-letter">C<');
    expect(html).toContain('cl-letter">A<');
    expect(html).toContain('cl-letter">N<');
  });

  test('a letter that is missing says WHY, rather than vanishing', () => {
    // A checklist that silently drops a line reads as "nothing to report".
    expect(page).toContain('Not shown:');
    expect(page).toMatch(/no filings cached yet/);
    expect(page).toMatch(/group ranks still building/);
    expect(page).toMatch(/13F not built yet/);
  });
});

describe('the card opens with the picture, then the numbers', () => {
  /*
   * CHART FIRST. The picture is what the eye goes to; everything under it is
   * a number explaining the picture. It was last, behind three folds — the
   * one thing readable at a glance placed after the things that have to be
   * read word by word.
   *
   * Then Range, News, CANSLIM: why it is moving, then O'Neil's checklist on
   * whether the move is worth owning.
   */
  const body = page.match(/fold\('chart'[\s\S]*?return fold\('canslim',/)[0];

  test('chart is the first section, then whether it is tradable at all', () => {
    // Volume & Float second: float, cap and RVOL decide whether the stock can
    // be traded, and that comes before any reason to be interested in it.
    const order = ["fold('chart'", "fold('volume'", "fold('range'", "fold('news'"];
    const at = order.map(k => page.indexOf(k));
    expect(at[0]).toBeGreaterThan(-1);
    for (let i = 1; i < at.length; i++) {
      expect(at[i - 1]).toBeLessThan(at[i]);
    }
  });

  test('no section is left outside the body, styled unlike the rest', () => {
    // Volume & Float used to sit above the badges in its own block: the one
    // part of the card with no heading band, no summary line, always open.
    expect(page).not.toMatch(/<div class="card-section vf-top">/);
  });

  test('...and CANSLIM still follows the news', () => {
    expect(body.indexOf("fold('news'")).toBeGreaterThan(-1);
    expect(body.indexOf("fold('news'"))
      .toBeLessThan(body.indexOf('canslimCardBlock'));
  });

  test('the popup is gone entirely', () => {
    expect(page).not.toContain('openCanslimPanel');
    expect(page).not.toContain('CANSLIM ⤢');
  });

  test('...but the full tables survived onto the card', () => {
    // The eight-quarter table is the part of C that cannot be said in a line,
    // which is exactly why it must not be the part that is hardest to reach.
    expect(page).toContain('function canslimTablesHTML');
    expect(page).toContain("fold('canslim-tables', 'Full tables'");
  });
});

describe('folds: one line until asked for more', () => {
  for (const k of ['chart', 'volume', 'range', 'news', 'canslim', 'context',
                   'price', 'emas', 'atr', 'pm']) {
    test(`${k} is a fold`, () => expect(page).toContain(`fold('${k}'`));
  }

  test('the open/closed choice is remembered per section, not per card', () => {
    // "Keep news open" is a statement about news; making it again on each of
    // 25 cards would be no saving at all.
    expect(page).toMatch(/localStorage\.setItem\('foldOpen'/);
  });

  test('opening the chart fold mounts the chart', () => {
    // The chart is mounted lazily by an IntersectionObserver, which cannot
    // see that a hidden element just became visible.
    const m = page.match(/function toggleFold[\s\S]*?\n\}/)[0];
    expect(m).toContain('_chartObserver.observe');
  });

  test('a section with no body renders nothing rather than an empty fold', () => {
    const m = page.match(/function fold\(key[\s\S]*?\n\}/)[0];
    expect(m).toContain("if (!body) return ''");
  });
});

describe('there are three type levels and they do not look alike', () => {
  /*
   * Reported from the live cards: "you can't distinguish between headers, sub
   * headers and information". Everything was rendering at 9px uppercase grey
   * — section headings, the sub-headings inside them, and the values — so the
   * card was one flat run of text with no shape.
   */
  const css = page.match(/\.fold-title \{[^}]*\}/)[0];
  // Anchored to the start of a line: '.mkt-fold[data-open="1"] > .fold-head'
  // also contains '.fold-head {' and would otherwise match first.
  const head = page.match(/^\.fold-head \{[^}]*\}/m)[0];
  const sub = page.match(/\.fold \.fold \.fold-title \{[^}]*\}/)[0];
  const subHead = page.match(/\.fold \.fold > \.fold-head \{[^}]*\}/)[0];

  /*
   * A HEADING WINS ON SHAPE, NOT BRIGHTNESS.
   *
   * The first attempt made headings large and bright and they still lost: a
   * green BULLISH or a red -5.83% is fully saturated, and no grey text
   * outranks a saturated colour however heavy it is. Those value colours mean
   * something and must stay loud — so headings are not entered in that
   * contest at all. Every one sits in a filled band; no value ever does.
   */
  test('a SECTION heading sits in a filled band', () => {
    expect(head).toMatch(/background: var\(--bg3\)/);
    expect(head).toMatch(/border-left: 3px solid/);
  });

  test('...and is uppercase and letterspaced, which no value is', () => {
    expect(css).toMatch(/text-transform: uppercase/);
    expect(css).toMatch(/letter-spacing: \.09em/);
  });

  test('a heading takes the FURNITURE colour, stealing no meaning', () => {
    // The colour language gives every hue one meaning: green and red are
    // DIRECTION, and a heading in them would read as a judgement about the
    // section. m-chrome is defined as carrying no meaning, which is exactly
    // what a label is.
    expect(css).toMatch(/color: var\(--m-chrome\)/);
    expect(css).not.toMatch(/--m-up|--m-down|--green|--red/);
  });

  test('a heading is BIGGER than every label nested under it', () => {
    /*
     * In sunlight mode --text3 is #aab2c4, near-white: the palette lifts every
     * grey so the screen stays readable outdoors, which deletes the lightness
     * steps hierarchy was resting on. A heading that is only "brighter grey"
     * than its sub-labels has no rank at all there. Size survives the palette.
     */
    const headingPx = parseFloat(css.match(/font-size: ([\d.]+)px/)[1]);
    const nested = page.match(
      /\.fold-body \.oneil-stat-label,[\s\S]*?\}/)[0];
    const nestedPx = parseFloat(nested.match(/font-size: ([\d.]+)px/)[1]);
    expect(headingPx).toBeGreaterThan(nestedPx);
  });

  test("a nested block loses its own card chrome", () => {
    // The O'Neil block was built as a standalone card. A bordered panel inside
    // a bordered section reads as two boxes, not one section.
    expect(page).toMatch(
      /\.fold-body \.oneil-block \{[^}]*border: 0[^}]*\}/);
  });

  test('the band gets stronger in sunlight, where text contrast is gone', () => {
    expect(page).toMatch(/body\.sunlight \.fold-head \{[^}]*background: var\(--bg4\)/);
  });

  test('a NESTED heading uses the same idea hollow, so it reads lower', () => {
    // Filling is what says SECTION. A sub-heading that filled too would just
    // be a second section.
    expect(subHead).toMatch(/background: none/);
    expect(sub).toMatch(/font-size: 9px/);
    expect(sub).toMatch(/var\(--text2\)/);
  });

  test('an open section is marked by more than a rotated chevron', () => {
    // A heading that looks identical open and closed gives no clue where you
    // are in a card of nine sections.
    expect(page).toMatch(/\.fold\[data-open="1"\] > \.fold-head \{[^}]*border-left-color/);
  });

  test('a value outranks its label', () => {
    // They were the same colour, so a row read as one grey run.
    const v = page.match(/\.ctx-val, \.price-val \{[^}]*\}/)[0];
    const l = page.match(/\.ctx-label, \.price-label \{[^}]*\}/)[0];
    expect(v).toContain('var(--text)');
    expect(l).toContain('var(--text2)');
  });

  test('a sub-row is indented rather than given an empty letter chip', () => {
    // "since the FTD" and "on the DD days" belong under M, and were rendered
    // with an empty <span class="cl-letter">, which printed a stray leading
    // space and read as a broken row.
    expect(page).not.toMatch(/cl-letter"><\/span>/);
    expect(page).toContain('cl-sub">since the FTD');
    expect(page).toContain('cl-sub">on the DD days');
  });
});

describe('the summary lines say something', () => {
  test('the news line carries the top headline, not an empty separator', () => {
    // It printed "5 stories ·" on every card: the items carry `h`, not
    // `title`, so the headline was undefined and only the dot survived.
    const m = page.match(/fold\('news',[\s\S]*?newsHTML\}<\/div>`\)\}/)[0];
    expect(m).toContain('.h ||');
    expect(m).not.toContain('.title ||');
  });

  test('a failed or paused scan is not reported as a completed one', () => {
    // It printed "Scan complete · undefined rows · —".
    const m = page.match(/async function runScan[\s\S]*?\n\}/)[0];
    expect(m).toContain("if (!d.ok) setStatus('Scan failed");
    expect(m).toContain('d.paused');
  });
});

describe('the market tab names and folds every block', () => {
  // It was six unlabelled slabs and only the heatmap carried a heading.
  const tab = page.match(
    /<div class="tab-pane" id="tab-market">[\s\S]*?SHORTLIST TAB/)[0];

  for (const [key, title] of [['idx', 'Indexes'], ['oneil', "O'Neil market model"],
                              ['analysis', 'Desk analysis'],
                              ['sectors', 'Sector heatmap'],
                              ['groups', 'Industry groups']]) {
    test(`${key} is a named fold`, () => {
      expect(tab).toContain(`data-mfold="${key}"`);
      expect(tab).toContain(title);
    });
  }

  test('the model is open by default — it decides whether to buy at all', () => {
    expect(tab).toMatch(/data-mfold="oneil" data-open="1"/);
  });

  test('the heavier blocks start folded', () => {
    expect(tab).toMatch(/data-mfold="sectors" data-open="0"/);
    expect(tab).toMatch(/data-mfold="groups" data-open="0"/);
  });

  test('every block the loaders write into is still on the tab', () => {
    // Folding must not remove an element a loader looks up by id, or the
    // block silently stops updating.
    for (const id of ['idx-grid', 'oneil-model', 'market-analysis',
                      'regime-card', 'sector-tbody', 'group-table']) {
      expect(tab).toContain(`id="${id}"`);
    }
  });

  test('its headings get the same treatment as the cards', () => {
    // Same classes, so the size and the furniture colour come for free — but
    // .mkt-fold is not a .fold, so the open-state accent had to be repeated
    // or a heading would look identical open and closed.
    expect(tab).toContain('class="fold-title"');
    expect(page).toMatch(
      /\.mkt-fold\[data-open="1"\] > \.fold-head \{[^}]*border-left-color/);
  });

  test('no block repeats its own name inside the fold that names it', () => {
    // Two headings for one block is an echo, not a hierarchy. The group table
    // printed "Industry groups" inside the fold headed "L · Industry groups",
    // and the market model did the same.
    expect(page).not.toContain('heatmap-title">Industry groups');
    expect(page).not.toContain("oneil-stat-label\">O'Neil market model");
  });

  test('sub-headings inside a market fold drop a level too', () => {
    const rule = page.match(
      /\.fold-body \.oneil-stat-label,[\s\S]*?\}/)[0];
    expect(rule).toContain('.analysis-title');
    expect(rule).toContain('.heatmap-title');
  });

  test('the open/closed choice is remembered separately from the cards', () => {
    // What you want open on a page you visit to make one decision is not what
    // you want open on a page of 25 cards.
    expect(page).toMatch(/localStorage\.setItem\('mktFold'/);
    expect(page).toContain('function restoreMktFolds');
  });
});

/*
 * I — INSTITUTIONAL SPONSORSHIP, THE LAST LETTER.
 *
 * O'Neil wants sponsorship PRESENT and INCREASING, and warns in the same
 * breath that a stock every fund already owns is over-owned with nobody left
 * to buy it. "More is better" is false at both ends, so the card reports a
 * number and a direction and refuses to grade it.
 */
describe('the I row', () => {
  const fn = page.match(/function f13CardBlock[\s\S]*?\n\}/)[0];

  test('it shows the holder count AND which way it is moving', () => {
    expect(fn).toContain('holders');
    expect(fn).toContain('s.direction');
    expect(fn).toContain('s.change');
  });

  test('it shows the quarters, so a direction can be checked not believed', () => {
    expect(fn).toContain('s.quarters');
  });

  test('an unmatched stock says so rather than reporting ZERO holders', () => {
    // Zero funds is a claim about the company. Unmatched is a fact about our
    // CUSIP-to-ticker matching, and they are opposite readings.
    expect(fn).toContain('not matched in 13F');
    expect(fn).toContain('NOT "0 funds", which is a claim');
  });

  test('it carries its letter, like every other row', () => {
    expect(fn).toContain('cl-letter">I<');
  });

  test('it sits between L and M, keeping the card in method order', () => {
    const sec = page.match(/const rows = canslimCardBlock[\s\S]*?;/)[0];
    expect(sec.indexOf('groupCardBlock'))
      .toBeLessThan(sec.indexOf('f13CardBlock'));
    expect(sec.indexOf('f13CardBlock'))
      .toBeLessThan(sec.indexOf('oneilCardBlock'));
  });

  test('its definition card says what it is NOT, including over-owned', () => {
    const d = DEFS.canslim_i;
    expect(d).toBeTruthy();
    expect(d.not).toMatch(/OVER-OWNED/);
    expect(d.not).toMatch(/NOT A SCORE/);
    expect(d.not).toMatch(/45 days late|quarterly/);
    expect(d.src).toMatch(/licensed/);
  });

  test('one file for every ticker, not a fetch per card', () => {
    // X5 again: 13F is quarterly and the whole answer is small.
    expect(page).toMatch(/async function loadF13/);
    expect(fn).not.toMatch(/fetch\(|await /);
  });
});

describe('a checklist has to line up', () => {
  /*
   * Reported from the live cards: the CANSLIM rows read "like baby
   * handwriting". The cause was .ctx-row being a flex with space-between, so
   * the label column was as wide as whatever label it held — "S supply"
   * started in one place and "on the DD days" in another, every (i) landed
   * somewhere different, and a long value wrapped back underneath its own
   * label. Reading DOWN the letters was the entire point and the layout made
   * it impossible.
   */
  const rule = page.match(/\.fold-body \.ctx-row \{[^}]*\}/)[0];

  test('rows inside a fold are a two-column grid, not a flex', () => {
    expect(rule).toContain('display: grid');
    expect(rule).toMatch(/grid-template-columns: \d+px 1fr/);
  });

  test('the label column has a FIXED width, so every value starts level', () => {
    expect(rule).not.toContain('auto 1fr');
  });

  test('rows are top-aligned, so a wrapped value does not centre its label', () => {
    expect(rule).toContain('align-items: start');
  });

  test('the definition icon cannot resize the label column', () => {
    const icon = page.match(/\.fold-body \.oneil-info \{[^}]*\}/)[0];
    expect(icon).toContain('flex: 0 0 auto');
  });

  test('it applies to every folded row, not only the letters', () => {
    // Relative Strength and Market Context were ragged for the same reason.
    expect(page).toContain('.fold-body .ctx-row');
    expect(page).not.toContain('.canslim-sec .ctx-row {');
  });
});

/*
 * THE S BLOCK, DRIVEN FOR REAL.
 *
 * A card printed "float 2.46M sh" in Volume & Float and "Float —" in the S
 * block below it, on the same screen. The merge that was supposed to fix that
 * was written and shipped, and changed nothing: buildCard opens with
 * `const s = row.stock || {}`, so floatShares and the short-interest fields
 * live on row.stock — and the call site passed `row`. Every one of them came
 * back undefined, and undefined renders as "—", which is precisely what a
 * genuinely missing float renders as. The bug's output was a legitimate
 * value, so nothing looked wrong.
 *
 * The audit guarding it asserted `'r.floatShares' in page` — a substring
 * search that passed while the code was broken and could never have failed,
 * because no amount of grepping can tell whether `r` is the right object.
 *
 * So this executes the function. It is the only kind of check that could have
 * caught it, and it is the principle this file's own header already states.
 */
function liftTables() {
  const grab = (re, what) => {
    const m = page.match(re);
    if (!m) throw new Error(`${what} not found in public/index.html — renamed?`);
    return m[0];
  };
  const src = [
    grab(/function _wins\(got, want, label\) \{[\s\S]*?\n\}/, '_wins()'),
    grab(/function _fundNote\(f\) \{[\s\S]*?\n\}/, '_fundNote()'),
    grab(/function canslimTablesHTML\(tk, stock\) \{[\s\S]*?\n\}\n/, 'canslimTablesHTML()'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('panel', `
    // EMITS ITS KEY, like the stub in lift() above: a heading is only wired
    // to an explanation if a specific definition is named, and an icon that
    // opens nothing looks identical to one that works.
    const info = k => '[[def:' + k + ']]';
    const esc = s => String(s == null ? '' : s);
    const _n = v => (v == null ? '—' : String(v));
    const _m = v => (v == null ? '—' : String(v));
    const _sign = v => (v == null ? '' : v >= 0 ? 'pos' : 'neg');
    const fmtShares = v => (v == null ? '—' : (v / 1e6).toFixed(2) + 'M sh');
    let CANSLIM_PANEL = panel;
    let GROUPS_MODEL = null, F13_MODEL = null;
    let ONEIL_RATINGS = {}, ONEIL_MODEL = {}, ONEIL_STOCKS = { stocks: {} };
    ${src}
    return canslimTablesHTML;
  `);
}

describe('S — the float the card already has', () => {
  const SUPPLY = {
    ok: true,
    s: {
      shares_outstanding: 3_435_357,
      as_of: '2026-08-07',
      shares_tag: 'EntityCommonStockSharesOutstanding',
      shares_basis: 'outstanding, from the filing cover',
      float: null,
      float_note: 'not in EDGAR — filers do not tag float; the screener supplies it',
    },
  };
  // EXACTLY THE FIELD NAMES Volume & Float reads off row.stock. If these ever
  // diverge, the two halves of the card disagree again.
  const STOCK = {
    floatShares: 2_460_000, shortFloat: 12.5, shortBasis: 'float',
    shortAsOf: '2026-08-15', daysToCover: 3.2,
  };
  const render = (stock, supply = SUPPLY) =>
    liftTables()({ fundamentals: { AAA: supply }, bases: {} })('AAA', stock);

  test('the float from the screener reaches the S block', () => {
    expect(render(STOCK)).toContain('2.46M sh');
  });

  test('...and is NOT read off the row, which does not carry it', () => {
    // The shape buildCard is handed. Passing this instead of row.stock is the
    // bug: every screener field is one level down.
    const row = { ticker: 'AAA', stock: STOCK };
    expect(render(row)).not.toContain('2.46M sh');
    expect(page).toContain('canslimTablesHTML(row.ticker, s)');
  });

  test('the fallback note appears only when there is genuinely no float', () => {
    const out = render({});
    expect(out).toContain('not in EDGAR');
    expect(out).not.toContain('from the screener');
  });

  test('a float that IS present never shows the "no float" note', () => {
    const out = render(STOCK);
    expect(out).toContain('from the screener');
    expect(out).not.toContain('not in EDGAR');
  });

  test('float is expressed against shares outstanding, which is the reading', () => {
    // 2.46M of 3.435M ≈ 72% — the number that says how much of the company
    // can actually trade.
    expect(render(STOCK)).toContain('72% of shares');
  });

  test('short interest and days to cover reach S, the supply letter', () => {
    const out = render(STOCK);
    expect(out).toContain('12.5%');
    expect(out).toContain('3.2');
    expect(out).toContain('days to cover');
  });

  test('...and are absent, not zero, when nothing is reported', () => {
    const out = render({ floatShares: 1e6 });
    expect(out).not.toContain('days to cover');
    expect(out).not.toContain('Short interest');
  });

  test('a weighted-average share count is flagged as one, never shown bare', () => {
    const wa = { ok: true, s: {
      shares_outstanding: 95_000_000,
      shares_tag: 'WeightedAverageNumberOfDilutedSharesOutstanding',
      shares_basis: 'a WEIGHTED AVERAGE over the period, diluted — not a count on a date',
    } };
    expect(render(STOCK, wa)).toContain('weighted avg');
  });

  test('the cover-page count carries no qualifier, being the plain answer', () => {
    expect(render(STOCK)).not.toContain('weighted avg');
  });

  /*
   * AND THE COUNT AGAINST ITSELF A YEAR AGO.
   *
   *   "we need the history to compare and check the progress but we need the
   *    most recent data"
   *
   * S was the one letter with no history on the card at all: a share count
   * and nothing to read it against. But O'Neil's S is not how many shares
   * exist, it is whether the number is SHRINKING — a company buying its own
   * stock back is taking supply out from under the same demand. One figure
   * cannot say that, and the filings the card already downloads carry every
   * figure needed to.
   */
  const withChg = (chg, hist) => ({
    ok: true,
    s: { ...SUPPLY.s, shares_chg_1y: chg, shares_history: hist },
  });

  test('a shrinking count is shown as a buyback, and green', () => {
    const out = render(STOCK, withChg(
      { pct: -6, from: '2025-06-30', from_val: 100e6,
        to: '2026-06-30', to_val: 94e6, days: 365 },
      [{ end: '2025-06-30', val: 100e6 }, { end: '2026-06-30', val: 94e6 }]));
    expect(out).toContain('Share count');
    expect(out).toContain('-6%');
    expect(out).toContain('buying back');
    expect(out).toContain('bias-bull');
  });

  test('a growing count is dilution, and red', () => {
    const out = render(STOCK, withChg(
      { pct: 18.4, from: '2025-06-30', from_val: 80e6,
        to: '2026-06-30', to_val: 94.7e6, days: 365 }, []));
    expect(out).toContain('+18.4%');
    expect(out).toContain('diluting');
    expect(out).toContain('bias-bear');
  });

  /* A SHARE COUNT DRIFTS through option exercises every quarter. Colouring
     half a percent as a buyback would make the colour mean nothing, which is
     the same failure as a green tick on a criterion nobody passed. */
  test('a drift of well under a percent is flat — neither colour', () => {
    const out = render(STOCK, withChg(
      { pct: -0.4, from: '2025-06-30', from_val: 94.4e6,
        to: '2026-06-30', to_val: 94e6, days: 365 }, []));
    expect(out).toContain('flat');
    expect(out).not.toContain('bias-bull');
    expect(out).not.toContain('bias-bear');
  });

  test('both figures and both dates are printed, so the number can be checked', () => {
    const out = render(STOCK, withChg(
      { pct: -6, from: '2025-06-30', from_val: 100e6,
        to: '2026-06-30', to_val: 94e6, days: 365 }, []));
    expect(out).toContain('2025-06-30');
    expect(out).toContain('2026-06-30');
    expect(out).toContain('365 days');
  });

  /* "NO COMPARISON YET" AND "NO DATA" ARE DIFFERENT FACTS about different
     companies, and a bare dash says the second when it means the first. A
     stock that listed nine months ago is not missing its history — it has not
     lived long enough to have one. */
  test('one count on file says so, rather than showing nothing', () => {
    const out = render(STOCK, withChg(null, [{ end: '2026-06-30', val: 94e6 }]));
    expect(out).toContain('only one count on file');
    expect(out).not.toContain('buying back');
  });

  test('...and counts that exist but are too bunched say THAT instead', () => {
    const out = render(STOCK, withChg(null, [
      { end: '2026-03-31', val: 100e6 }, { end: '2026-06-30', val: 94e6 }]));
    expect(out).toContain('too bunched');
  });

  test('a stock with no share count at all adds no line about one', () => {
    const out = render(STOCK, { ok: true, s: { shares_outstanding: null } });
    expect(out).not.toContain('Share count');
  });

  test('the direction is never invented from the headline figure alone', () => {
    // No shares_chg_1y on the payload at all — an older cached record. It must
    // read as "no direction yet", never as flat.
    const out = render(STOCK);
    expect(out).not.toContain('buying back');
    expect(out).not.toContain('diluting');
    expect(out).toContain('only one count on file');
  });
});

/*
 * THE METHOD GOES BEHIND THE ⓘ, AND THE HEADINGS BECOME HEADINGS.
 *
 * Every card carried three standing paragraphs — how a year-over-year
 * comparison works, what "wobble" measures, why bases are read on weekly
 * bars. Reported plainly: "this is speech it's not information — you can make
 * it in ⓘ." Right twice over, because the definitions ALREADY said all of it,
 * and said it better: the method was on the card twice while the numbers it
 * explained got the same weight as the explanation.
 *
 * These assert the wiring survives, because a definition key is easy to drop
 * in an edit and the loss is silent — the heading simply stops offering the
 * explanation and nothing looks broken.
 */
describe('FULL TABLES headings carry their definition', () => {
  const render = () =>
    liftTables()({ fundamentals: {}, bases: {} })('AAA', {});

  const EXPECTED = [
    ['C — current quarterly earnings', 'canslim_c'],
    ['A — annual earnings', 'canslim_a'],
    ['N — the base (WEEKLY) and what is new', 'canslim_n'],
    ['S — supply', 'demand'],
    ['L — leader or laggard', 'group_rank'],
    ['I — institutional sponsorship', 'canslim_i'],
    ['M — market direction', 'oneil_model'],
  ];

  test.each(EXPECTED)('%s opens its definition', (title, key) => {
    // `info` is stubbed by lift() to emit its key, so this checks the heading
    // is wired to a definition rather than merely that an icon exists.
    expect(render()).toContain(`${title}[[def:${key}]]`);
  });

  test('every key names a definition that actually exists', () => {
    const defs = page.match(/const DEFS = \{[\s\S]*?\n\};/)[0];
    for (const [, key] of EXPECTED) expect(defs).toContain(`  ${key}: {`);
  });

  test('no standing methodology paragraph is left in the card body', () => {
    const out = render();
    // The only def-src that may remain is the sources-and-dates footer, which
    // is per-card FACT — the dates are the one way to tell fresh from stale.
    expect((out.match(/def-src/g) || []).length).toBe(1);
    expect(out).toContain('Sources and dates');
  });

  test('the three paragraphs are gone by name', () => {
    expect(page).not.toContain('esc(c.note)');
    expect(page).not.toContain('esc(a.stability_note)');
    expect(page).not.toContain('b.timeframe_note');
  });

  test('a heading outranks the table under it — size and a rule, not grey', () => {
    const rule = page.match(/\.fold-body \.def-sec-title \{[^}]*\}/)[0];
    expect(rule).toMatch(/font-size: 11\.5px/);
    expect(rule).toContain('border-left');
    // Lightness cannot carry it: sunlight mode lifts --text3 to near-white.
    expect(rule).not.toContain('var(--text3)');
  });
});
