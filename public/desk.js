/*
 * The two behaviours every page on this desk shares.
 *
 * Kept beside desk.css rather than copied into four <script> blocks, for the
 * same reason the tokens are: four copies of one idea drift, and the one that
 * drifts is always the page you look at least.
 */

/*
 * SUNLIGHT MODE, and it is ON by default.
 *
 * A dark theme outdoors is a mirror. The screener has treated high contrast as
 * the normal case and the dark palette as the opt-out since the day someone
 * tried to read a card at a bus stop, and every other page kept its own dark
 * palette with no way out of it at all.
 *
 * Applied before the first data arrives, so a page comes up readable rather
 * than flashing the low-contrast palette and then correcting itself.
 */
function deskSunlight() {
  let on = true;
  try { on = localStorage.getItem('sunlight') !== '0'; } catch { /* private mode */ }
  /*
   * The ROOT element, not just the body.
   *
   * This script is in <head>, which is where it has to be — a palette applied
   * after the first paint is a page that flashes dark and then corrects
   * itself. But <body> does not exist yet at that point, and reaching for its
   * classList there threw on every page. documentElement always exists, so the
   * variables land from the first byte; the body gets the same class as soon
   * as there is one, because the screener's own rules are written against it.
   */
  document.documentElement.classList.toggle('sunlight', on);
  if (document.body) document.body.classList.toggle('sunlight', on);
  const b = document.getElementById('sun-btn');
  if (b) {
    b.classList.toggle('on', on);
    b.title = on ? 'back to normal contrast'
                 : 'high contrast, for reading the screen outdoors';
  }
}

function toggleSunlight() {
  const on = !document.documentElement.classList.contains('sunlight');
  try { localStorage.setItem('sunlight', on ? '1' : '0'); } catch { /* private mode */ }
  deskSunlight();
}

/*
 * FOLD THE LONG EXPLANATIONS AWAY.
 *
 * Anything past a couple of lines goes behind a small "why" you can tap.
 * Length is the test, so a genuinely short note — "6 fired", "not saved" — is
 * left exactly where it is, and only .risk-hint / .cmp-hint blocks are
 * touched: those are explanations by construction. Warnings, counts and errors
 * are never hidden.
 *
 * Done in code rather than by hand because these paragraphs are spread over
 * thousands of lines, and a rule applied once catches the ones written next
 * month too.
 */
const DESK_WHY_LIMIT = 150;

function deskFoldWhy(root = document) {
  for (const el of root.querySelectorAll('.risk-hint:not([data-folded]), .cmp-hint:not([data-folded])')) {
    el.setAttribute('data-folded', '1');
    if (el.textContent.trim().length < DESK_WHY_LIMIT) continue;
    // Buttons and inputs live inside some of these blocks. Those are controls,
    // not prose, and they stay on screen — only the words fold.
    const controls = [...el.childNodes].filter(
      n => n.nodeType === 1 && n.matches('button, input, select, a, code, textarea, div.cmp-row'));
    const d = document.createElement('details');
    d.className = 'why';
    const sum = document.createElement('summary');
    sum.textContent = 'why';
    const body = document.createElement('div');
    body.className = 'why-body';
    body.innerHTML = el.innerHTML;
    for (const c of body.querySelectorAll('button, input, select, textarea, div.cmp-row')) c.remove();
    d.append(sum, body);
    el.innerHTML = '';
    el.append(...controls, d);
  }
}

document.addEventListener('DOMContentLoaded', () => { deskSunlight(); deskFoldWhy(); });
// The palette must not wait for DOMContentLoaded — a page that paints dark and
// then goes light is worse than one that was always dark.
deskSunlight();
