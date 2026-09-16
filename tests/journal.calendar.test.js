/*
 * THE CALENDAR PUT THE WRONG NUMBER UNDER THE WRONG DAY.
 *
 * The journal's Calendar tab is a 6-column grid — Mon Tue Wed Thu Fri Week —
 * and Sep 15 2026, a Tuesday, rendered under Thursday. It is the page used to
 * compare a live session against its backtest, so a day read off the wrong
 * column is a comparison against the wrong day.
 *
 * THREE FAULTS, and the third could not be found by reading.
 *
 * 1. THE WEEK TOTAL WAS WRITTEN TWICE. `if (dw===4) flushWeek()` closes the
 *    week on Friday, and `if (dw>4){if(dw===5)flushWeek();continue;}` closed
 *    it again on Saturday. Every full week emitted two Week cells, and each
 *    extra cell shoves the rest of the month one column left.
 *
 * 2. THE LAST WEEK WAS NEVER PADDED. A month ending on a Wednesday emits three
 *    day cells and then the Week total, so the total lands in column 4.
 *
 * 3. AND THE LAST WEEK WAS ONLY CLOSED IF IT CONTAINED A TRADE. The final
 *    `if (weekHas) flushWeek()` reads `weekHas`, which is set only when a day
 *    has a RECORD. A month whose last few days were quiet ended with an
 *    unclosed row — no padding, no Week cell, a grid that is not a multiple of
 *    six. Whether a week TRADED and whether its row is OPEN are two different
 *    questions and one flag was answering both.
 *
 *    This one is invisible to reading. It appears only when the last week of
 *    the month has no trades in it, so it survived (1) and (2) being found and
 *    was caught by RUNNING the real function over 48 months. A substring
 *    search cannot verify behaviour — only executing the function can.
 *
 * WHY THE FIX IS IN THE LAUNCHER. journal.html is 1,079 lines on a branch with
 * no shared history with this repo; forking it would put two copies in
 * circulation and guarantee they drift, which is why the add-ons are injected
 * rather than merged. A patch.js override would have to restate the whole
 * 60-line render function — the same fork in a different file. The launcher
 * replaces three expressions in the source string and nothing else.
 *
 * THESE TESTS RUN THE REAL PAGE, patched exactly as the launcher patches it,
 * and read the cells it produces. Nothing here asserts on the text of a fix.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SH = fs.readFileSync(path.join(ROOT, 'deploy', 'journal-tool.sh'), 'utf8');
const APP_BRANCH = 'claude/test-9d4txv';

/**
 * fixCalendar, lifted out of the launcher exactly as it is written there.
 *
 * `warned` collects what it says when a needle misses — the case that decides
 * whether a stale patch is loud or silent, so it is captured rather than
 * swallowed. CAL_FIXES is handed out explicitly because a `const` inside a vm
 * script does not become a property of the context the way a function
 * declaration does.
 */
function launcherFix(warned = []) {
  const i = SH.indexOf('const CAL_FIXES = [');
  /*
   * A LAUNCHER WITH NO FIX IN IT IS A RESULT, NOT A CRASH. Throwing here would
   * take the whole suite down at import and report "0 tests" — which is the
   * shape of a pass, not of a failure, and is precisely the confusion this
   * file exists to end. It hands back a fix that does nothing, so the LAYOUT
   * assertions below are what fail, saying which column the total landed in.
   */
  if (i < 0) return { fixCalendar: (html) => html, CAL_FIXES: [] };
  const end = '  return html;\n}';
  const j = SH.indexOf(end, i) + end.length;
  const ctx = { console: { warn: (m) => warned.push(m) } };
  vm.createContext(ctx);
  vm.runInContext(`${SH.slice(i, j)}\nthis.CAL_FIXES = CAL_FIXES;`, ctx);
  return ctx;
}

/*
 * THE PAGE ITSELF, from the branch that serves it. Not a fixture copied into
 * this repo: a copy would drift from what is actually served, and a test
 * passing against a stale copy of the file is worse than no test.
 *
 * IT FAILS RATHER THAN SKIPS when the branch is not there. A skipped test
 * reports the same green as a passing one, and the whole subject here is a
 * silence being read as a pass.
 */
function journalHtml() {
  const show = () => execFileSync('git', ['show', `origin/${APP_BRANCH}:public/journal.html`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 << 20 });
  try {
    return show();
  } catch (e) {
    execFileSync('git', ['fetch', 'origin', APP_BRANCH], { cwd: ROOT, stdio: 'ignore' });
    return show();
  }
}

const RAW = journalHtml();
const { fixCalendar, CAL_FIXES } = launcherFix();
const PATCHED = fixCalendar(RAW);

/** The grid's own children, stopping at the tag that closes the grid. */
function gridCells(html) {
  const open = '<div class="jnl-cal-grid">';
  const s = html.slice(html.indexOf(open) + open.length);
  const out = [];
  let depth = 0, start = -1, m;
  const re = /<div\b[^>]*>|<\/div>/g;
  while ((m = re.exec(s))) {
    if (m[0] === '</div>') {
      if (depth === 0) break;
      depth -= 1;
      if (depth === 0) { out.push(s.slice(start, m.index + 6)); start = -1; }
    } else {
      if (depth === 0) start = m.index;
      depth += 1;
    }
  }
  return out;
}

/*
 * A DAY CELL WITH NO TRADE AND AN EMPTY WEEK CELL ARE THE SAME COLOUR — both
 * background #0b1220 with a #1e293b border. The day number inside is the only
 * thing that tells them apart, which is itself worth knowing: it is why this
 * has to be rendered rather than pattern-matched.
 */
const kindOf = c => (c.trim() === '<div></div>' ? 'pad'
  : (c.match(/font-size:8px">(\d+)</) || [])[1] || 'WEEK');

/** Render the real (patched) calendar for a month and return its cells. */
function render(html, month, days = {}) {
  const fn = html.match(/function jnl_renderCalendarTab\(trades\) \{[\s\S]*?\n\}/);
  expect(fn).toBeTruthy();
  const ctx = {
    document: { getElementById: () => ({
      set innerHTML(v) { ctx.out = v; }, querySelectorAll: () => [] }) },
    localStorage: { getItem: () => month, setItem() {} },
    jnl_dailyPnl: () => days,
    jnl_fmt$: n => (n >= 0 ? '+$' : '-$') + Math.abs(n),
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${fn[0]}\njnl_renderCalendarTab([]);`, ctx);
  return gridCells(ctx.out).slice(6);              // past the 6 column headers
}

/** Every cell sitting in a column it does not belong in. */
function misplaced(cells) {
  const bad = [];
  if (cells.length % 6) bad.push(`${cells.length} cells — the grid is 6 wide`);
  cells.forEach((c, i) => {
    const k = kindOf(c), col = i % 6;
    if (k === 'WEEK' && col !== 5) bad.push(`week total in column ${col + 1}`);
    if (k !== 'WEEK' && col === 5) bad.push(`'${k}' in the Week column`);
  });
  return bad;
}

const SEPT = {
  '2026-09-01': { pnl: 120, count: 2 },
  '2026-09-15': { pnl: 516, count: 3 },
  '2026-09-30': { pnl: -80, count: 1 },
};

describe('the month that was reported wrong', () => {
  test('the launcher carries all three fixes', () => {
    expect(CAL_FIXES.map(f => f.what)).toEqual([
      'the Saturday double-flush',
      'padding the last week to the Week column',
      'closing a final week that had no trades in it',
    ]);
  });

  test('September 2026 lays out with every week total under Week', () => {
    expect(misplaced(render(PATCHED, '2026-09', SEPT))).toEqual([]);
  });

  /*
   * THE ORIGINAL IS STILL BROKEN, which is what makes the above mean anything.
   * If this ever passes, the page has been fixed at source and the launcher's
   * patch is dead weight that should be removed.
   */
  test('and the unpatched page is still wrong, or this test proves nothing', () => {
    expect(misplaced(render(RAW, '2026-09', SEPT)).length).toBeGreaterThan(0);
  });

  test('Sep 15 is a Tuesday and renders in the Tuesday column', () => {
    const cells = render(PATCHED, '2026-09', SEPT);
    const at = cells.findIndex(c => kindOf(c) === '15');
    expect(at).toBeGreaterThan(-1);
    expect(at % 6).toBe(1);                         // Mon=0, Tue=1
  });

  test('and in the unpatched page it does not', () => {
    const cells = render(RAW, '2026-09', SEPT);
    expect(cells.findIndex(c => kindOf(c) === '15') % 6).not.toBe(1);
  });
});

describe('every month, not just the one that was noticed', () => {
  const months = [];
  for (let y = 2024; y <= 2027; y += 1) {
    for (let mo = 1; mo <= 12; mo += 1) {
      months.push(`${y}-${String(mo).padStart(2, '0')}`);
    }
  }

  test('48 months lay out correctly', () => {
    const broken = months
      .map(k => [k, misplaced(render(PATCHED, k, { [`${k}-15`]: { pnl: 100, count: 1 } }))])
      .filter(([, b]) => b.length);
    expect(broken.map(([k, b]) => `${k}: ${b[0]}`)).toEqual([]);
  });

  /*
   * FAULT 3, ON ITS OWN. A month whose last week is quiet is the case the
   * first two fixes do not reach, and the case that is invisible to reading.
   */
  test('a month whose last week has no trades still closes its row', () => {
    // September 2026 ends Wed 30; put the only trade in the first week.
    const cells = render(PATCHED, '2026-09', { '2026-09-01': { pnl: 50, count: 1 } });
    expect(cells.length % 6).toBe(0);
    expect(kindOf(cells[cells.length - 1])).toBe('WEEK');
  });

  test('a month with no trades at all still lays out', () => {
    expect(misplaced(render(PATCHED, '2026-09', {}))).toEqual([]);
  });

  /*
   * A MONTH STARTING ON A WEEKEND. No padding is emitted, so Monday must be
   * the first cell — the case where the old Saturday flush pushed an empty
   * Week cell into the Monday column.
   */
  test('a month starting on a Saturday starts on the Monday after', () => {
    // 2026-08-01 is a Saturday.
    const cells = render(PATCHED, '2026-08', { '2026-08-15': { pnl: 10, count: 1 } });
    expect(misplaced(cells)).toEqual([]);
    expect(kindOf(cells[0])).toBe('3');            // Mon 3 Aug
  });
});

describe('the numbers are still the page\'s own', () => {
  /*
   * A LAYOUT FIX MUST NOT MOVE THE MONEY. The whole value of this page is that
   * its figures are the journal's; shifting a cell is the bug, changing a
   * total would be a worse one.
   */
  test('the month total is untouched by the patch', () => {
    const total = html => {
      const fn = html.match(/function jnl_renderCalendarTab\(trades\) \{[\s\S]*?\n\}/)[0];
      const ctx = {
        document: { getElementById: () => ({
          set innerHTML(v) { ctx.out = v; }, querySelectorAll: () => [] }) },
        localStorage: { getItem: () => '2026-09', setItem() {} },
        jnl_dailyPnl: () => SEPT,
        jnl_fmt$: n => (n >= 0 ? '+$' : '-$') + Math.abs(n),
        console,
      };
      ctx.window = ctx; vm.createContext(ctx);
      vm.runInContext(`${fn}\njnl_renderCalendarTab([]);`, ctx);
      return (ctx.out.match(/Month: <b[^>]*>([^<]+)</) || [])[1];
    };
    expect(total(PATCHED)).toBe(total(RAW));
    expect(total(PATCHED)).toBe('+$556');           // 120 + 516 - 80
  });

  test('every day of the month is still drawn exactly once', () => {
    const cells = render(PATCHED, '2026-09', SEPT);
    const days = cells.map(kindOf).filter(k => k !== 'WEEK' && k !== 'pad');
    expect(new Set(days).size).toBe(days.length);
    expect(days).toContain('1');
    expect(days).toContain('30');
  });
});

describe('a patch that stops matching says so', () => {
  /*
   * THE BRANCH CAN MOVE. If these needles ever stop matching, a silent no-op
   * puts the bug back with nothing to read — which is the failure this whole
   * week has been about. It warns, and it still serves the page: a mislaid
   * week total is not worth a blank journal.
   */
  test('a page without the needles is returned, not thrown on', () => {
    const warned = [];
    const out = launcherFix(warned).fixCalendar('<html>not the journal</html>');
    expect(out).toBe('<html>not the journal</html>');
    expect(warned.length).toBe(1);
    expect(warned[0]).toMatch(/calendar NOT patched/);
  });

  test('and it names which fixes missed', () => {
    const warned = [];
    // Only the first needle present: the other two must be named as missed.
    launcherFix(warned).fixCalendar('if (dw>4){if(dw===5)flushWeek();continue;}');
    expect(warned[0]).toMatch(/Week column/);
    expect(warned[0]).toMatch(/no trades/);
  });

  test('a fully patched page warns about nothing', () => {
    const warned = [];
    launcherFix(warned).fixCalendar(RAW);
    expect(warned).toEqual([]);
  });

  test('each needle appears exactly once in the page it patches', () => {
    for (const f of CAL_FIXES) {
      expect(RAW.split(f.find).length - 1).toBe(1);
    }
  });
});

describe('the fix is served on every request, not only with the add-ons', () => {
  /*
   * The calendar is a correction to the page's own arithmetic, not an add-on,
   * so it must not be behind the JOURNAL_PATCH_JS flag. This is the one thing
   * here that can only be read from the text — the route cannot be run.
   */
  test('fixCalendar runs before the no-patch return', () => {
    const route = SH.slice(SH.indexOf("app.get('/', (req, res)"),
      SH.indexOf('const PORT = process.env.PORT'));
    expect(route).toMatch(/html = fixCalendar\(html\);/);
    expect(route.indexOf('html = fixCalendar(html);'))
      .toBeLessThan(route.indexOf('if (!PATCH) return res.type'));
  });
});
