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
