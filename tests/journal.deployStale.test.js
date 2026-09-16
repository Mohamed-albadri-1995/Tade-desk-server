/*
 * A DEPLOY SCRIPT THAT RE-DEPLOYS ITSELF FROM A STALE CHECKOUT.
 *
 * The calendar fix (8595ba5) was pushed, and `./deploy/journal-tool.sh` was
 * run on the box. The page came back without the fix in it, and nothing said
 * so. The deploy reported:
 *
 *     GET /                    → 200
 *     GET /api/journal/trades  → 200
 *     GET /_patch.js           → 200
 *     patch injected into / : 1
 *
 * Four green checks over a page that still had the bug.
 *
 * TWO FAULTS, AND THEY COVERED FOR EACH OTHER.
 *
 * 1. THIS SCRIPT NEVER PULLS THE REPO IT LIVES IN. It fetches the journal APP
 *    branch — claude/test-9d4txv — and nothing else. So a fix landing in the
 *    launcher is not on the box until somebody runs `git pull` for an
 *    unrelated reason, and running the launcher from a stale checkout
 *    re-deploys the OLD launcher. deploy-tools.sh carries this exact lesson at
 *    its top — "A deploy script that only takes effect on the NEXT deploy is a
 *    trap with no floor" — but it pulls first, so it cannot happen there.
 *
 *    It still must NOT pull: pulling the desk repo from here would rewrite
 *    tool code on disk without restarting the tools, which is a worse surprise
 *    than stopping. So it stops and prints the command.
 *
 * 2. AND ITS OWN VERIFICATION COULD NOT FAIL. "patch injected into /" asks
 *    whether the <script> tag is in the page, which it always is — the tag is
 *    injected by a line that has not changed in months. It answered 1 for a
 *    page with the bug and would answer 1 for a page with every fix stripped
 *    out. A field that says the same thing whatever happened, in a deploy's
 *    own health check.
 *
 * Both are executed here, in real git repositories and against real page
 * bodies. A substring search cannot verify behaviour — the whole failure was a
 * check whose text read correctly.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SH = fs.readFileSync(path.join(ROOT, 'deploy', 'journal-tool.sh'), 'utf8');

/**
 * A named region of the launcher, lifted out to be run on its own.
 *
 * A MISSING REGION IS AN EMPTY ONE, NOT A THROW. Throwing here takes the suite
 * down during collection and reports "0 tests" — which is the shape of a pass,
 * not of a failure. Empty means the guard below runs nothing, so what fails is
 * the assertion that a stale checkout STOPS, which names the actual defect.
 */
function slice(from, to) {
  const i = SH.indexOf(from);
  if (i < 0) return '';
  const j = SH.indexOf(to, i);
  return j > i ? SH.slice(i, j) : '';
}

function sh(script, cwd) {
  try {
    return { out: execFileSync('bash', ['-c', script], { cwd, encoding: 'utf8' }), code: 0 };
  } catch (e) {
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status };
  }
}

/* ── 1. the staleness guard, in three real git states ──────────────────── */

describe('a launcher behind its own origin', () => {
  const GUARD = slice('# ── IS THIS SCRIPT ITSELF CURRENT?',
    '# ── the code, as a worktree');
  let dir;

  /** A repo whose deploy/journal-tool.sh is the guard plus a marker line. */
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jnl-stale-'));
    const work = path.join(dir, 'work');
    sh(`git init -q --bare "${dir}/origin" && git clone -q "${dir}/origin" "${work}"`, dir);
    fs.mkdirSync(path.join(work, 'deploy'), { recursive: true });
    fs.writeFileSync(path.join(work, 'deploy', 'journal-tool.sh'),
      '#!/usr/bin/env bash\nset -euo pipefail\n'
      + 'REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"\n'
      + GUARD + '\necho "RAN THE LAUNCHER"\n');
    sh('git config user.email t@t && git config user.name t'
      + ' && chmod +x deploy/journal-tool.sh && git add -A && git commit -qm one'
      + ' && git push -q origin HEAD:main && git branch -q -M main'
      + ' && git branch --set-upstream-to=origin/main main -q', work);
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = () => sh('./deploy/journal-tool.sh', path.join(dir, 'work'));

  test('the launcher has a staleness guard at all', () => {
    expect(GUARD).not.toBe('');
  });

  test('a current checkout runs', () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RAN THE LAUNCHER/);
  });

  /*
   * THE ONE THAT WAS BROKEN. Before this, a checkout behind origin ran the old
   * launcher and reported a clean deploy.
   */
  test('a checkout behind origin STOPS instead of deploying old code', () => {
    const work = path.join(dir, 'work');
    sh('sed -i "s/RAN THE LAUNCHER/VERSION TWO/" deploy/journal-tool.sh'
      + ' && git commit -qam two && git push -q origin main'
      + ' && git reset -q --hard HEAD~1', work);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/STOPPED/);
    expect(r.out).not.toMatch(/RAN THE LAUNCHER/);
  });

  test('and it says why, and the command that fixes it', () => {
    const r = run();
    expect(r.out).toMatch(/never pulls/);
    expect(r.out).toMatch(/git -C .* pull &&/);
  });

  /*
   * A LOCAL EDIT IS NOT STALENESS. Refusing to deploy somebody's own
   * uncommitted change would be the more annoying failure, so it is named and
   * the run continues.
   */
  test('an uncommitted local edit runs, with a note', () => {
    const work = path.join(dir, 'work');
    fs.appendFileSync(path.join(work, 'deploy', 'journal-tool.sh'), '# local tweak\n');
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/uncommitted local edits/);
    expect(r.out).toMatch(/RAN THE LAUNCHER/);
  });

  test('a repo with no upstream at all does not block the deploy', () => {
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), 'jnl-solo-'));
    fs.mkdirSync(path.join(solo, 'deploy'), { recursive: true });
    fs.writeFileSync(path.join(solo, 'deploy', 'journal-tool.sh'),
      '#!/usr/bin/env bash\nset -euo pipefail\n'
      + 'REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"\n'
      + GUARD + '\necho "RAN THE LAUNCHER"\n');
    sh('git init -q . && git config user.email t@t && git config user.name t'
      + ' && git add -A && git commit -qm one', solo);
    const r = sh('bash ./deploy/journal-tool.sh', solo);
    expect(r.out).toMatch(/RAN THE LAUNCHER/);
    fs.rmSync(solo, { recursive: true, force: true });
  });
});

/* ── 2. the verification, against real page bodies ─────────────────────── */

describe('the deploy checks the page, not the script tag', () => {
  /*
   * TO THE `fi` THAT CLOSES IT, not to the next line that mentions the page.
   * Ending on "Landing page tile:" cut the block mid-`echo "`, and bash
   * reported an unbalanced quote on stderr while the assertions still passed
   * — a fragment that never ran, reported as a pass, in the file about checks
   * that cannot fail. The extracted fragment is syntax-checked below so that
   * cannot happen quietly again.
   */
  const CHECK = (() => {
    const i = SH.indexOf("echo -n 'calendar grid fixed");
    if (i < 0) return '';
    const j = SH.indexOf('\nfi\n', i);
    return j > i ? SH.slice(i, j + '\nfi\n'.length) : '';
  })();

  test('the launcher has a calendar check at all', () => {
    expect(CHECK).not.toBe('');
  });

  test('the extracted fragment is valid shell, or nothing below means anything', () => {
    const f = path.join(os.tmpdir(), `jnl-frag-${process.pid}.sh`);
    fs.writeFileSync(f, CHECK);
    const r = sh(`bash -n ${f}`);
    fs.unlinkSync(f);
    expect(r.out).toBe('');
    expect(r.code).toBe(0);
  });

  /** Run the check with curl stubbed to return `page`. */
  function verify(page) {
    const f = path.join(os.tmpdir(), `jnl-verify-${Date.now()}-${Math.random()}.sh`);
    fs.writeFileSync(f, 'set -uo pipefail\nPORT=0\n'
      + `curl() { printf '%s' ${JSON.stringify(page)}; }\n` + CHECK);
    const r = sh(`bash ${f}`);
    fs.unlinkSync(f);
    // A shell error here would otherwise read as "the check printed nothing",
    // which several assertions below would happily accept.
    expect(r.out).not.toMatch(/unexpected EOF|syntax error/);
    return r.out;
  }

  const FIXED = 'function flushWeek(){while(cells.length%6!==5)cells.push'
    + "('<div></div>');cells.push(x)}  if (dw>4){continue;}";
  const BROKEN = 'function flushWeek(){cells.push(x)}  '
    + 'if (dw>4){if(dw===5)flushWeek();continue;}';

  test('a patched page reports the fix', () => {
    expect(verify(FIXED)).toMatch(/yes — week totals sit under Week/);
  });

  /*
   * THE WHOLE POINT. This is the page the box actually served, and every
   * existing check said the deploy was clean.
   */
  test('the page that was served reports NO, not a pass', () => {
    const out = verify(BROKEN);
    expect(out).toMatch(/NO — the page still has the double week total/);
    expect(out).not.toMatch(/yes —/);
  });

  test('and a reader can tell the two runs apart', () => {
    expect(verify(FIXED)).not.toBe(verify(BROKEN));
  });

  /*
   * AN ERROR IS NEVER A ZERO. A page that did not answer, and a page that
   * matches neither version, are each their own answer — never a pass.
   */
  test('no answer is COULD NOT CHECK, not ok', () => {
    const out = verify('');
    expect(out).toMatch(/COULD NOT CHECK/);
    expect(out).not.toMatch(/yes —/);
  });

  test('a page matching neither version says so rather than guessing', () => {
    const out = verify('<html>something else entirely</html>');
    expect(out).toMatch(/UNKNOWN/);
    expect(out).not.toMatch(/yes —/);
  });

  /*
   * AND THE OLD CHECK IS STILL THERE — it answers a different question (is the
   * add-on script tag present) and that question is still worth asking. What
   * was wrong was treating it as the answer to this one.
   */
  test('the script-tag check is kept, not replaced', () => {
    expect(SH).toMatch(/patch injected into \/ :/);
  });
});
