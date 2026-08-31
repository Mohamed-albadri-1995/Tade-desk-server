/*
 * Cut the tests off from the machine's real credentials.
 *
 * This exists because of a failure that only appeared on the deployment box.
 * `getKey` reads three sources in order — the tool's own settings row, the
 * shared data/keys.json, then the environment. A test that supplies a key by
 * setting an environment variable is therefore testing the LAST of the three,
 * and on a laptop with no keys.json and no populated database that is the one
 * that answers. On the server both of the higher-priority sources exist and
 * hold real keys, so "no key is configured" quietly became "a key is
 * configured", and two tests failed on `npm test` after a deploy while passing
 * everywhere else.
 *
 * A test suite that behaves differently depending on which machine runs it is
 * worse than a failing one: it fails at the moment you are least able to tell a
 * real regression from a local quirk. So both higher-priority sources are
 * pointed somewhere empty for every test file.
 *
 * Set before any test module loads — sharedKeys.js resolves the file path once,
 * at require time — which is what makes this a setupFiles entry rather than
 * something a test could do in beforeEach.
 */

const os = require('os');
const path = require('path');

// A path that deliberately does not exist. readShared() treats an unreadable
// file as "no shared keys", which is the state these tests mean to describe.
process.env.SHARED_KEYS_FILE = path.join(os.tmpdir(), 'jest-no-such-keys-file.json');

// And a scratch database, so a settings row on the real one cannot answer
// either. Individual suites that set their own DB_PATH still win — they assign
// it at the top of the file, which runs after this.
process.env.DB_PATH = process.env.DB_PATH
  || path.join(os.tmpdir(), `jest-default-${process.pid}.db`);

/*
 * The third source, and the one that caught this out twice.
 *
 * Blocking the file and the database left the environment, which is where the
 * tests themselves put a key when they want one present — so it looked like the
 * source under the test's control. It is not: the deployment box exports the
 * Alpaca credentials for the chart platform that shares the machine, so
 * `mockHosts({})` ran with a live key in scope and the fetcher went looking for
 * a host nobody had mocked. Finnhub happened not to be exported, which is why
 * only half the failure disappeared when the other two sources were cut off.
 *
 * Cleared here rather than in the suites: this runs before any test module
 * loads, and a suite that wants a key sets it afterwards in beforeEach, so the
 * value under test is always the one the test wrote.
 *
 * Every variable getKey falls back to belongs on this list — grep for getKey(
 * in src/ if a fourth credential is ever added.
 */
for (const v of ['APCA_API_KEY_ID', 'APCA_API_SECRET_KEY', 'FINNHUB_API_KEY']) {
  delete process.env[v];
}

/*
 * ...AND OFF THE REAL SESSION LOG.
 *
 * The same idea, for a file rather than a credential. `runSetup` now writes one
 * line per decision, so every suite that runs a setup with a stubbed feed
 * appends an invented run — fake tickers, fake fills, dated whenever the test
 * says — to the record of what the desk actually did. That file is what a
 * morning gets reviewed from, and a review cannot be worth anything if a test
 * run can put trades into it.
 *
 * Found the honest way: a full `npx jest` wrote rows into
 * data/history/session-2026-08.jsonl.
 *
 * Set here, before any module resolves the path, for the same reason as the
 * lines above. A suite that wants its own directory still wins — it assigns
 * SESSION_LOG_DIR at the top of the file, which runs after this.
 */
process.env.SESSION_LOG_DIR = process.env.SESSION_LOG_DIR
  || path.join(os.tmpdir(), `jest-session-log-${process.pid}`);
