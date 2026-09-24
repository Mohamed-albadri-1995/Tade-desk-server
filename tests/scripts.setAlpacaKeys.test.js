/*
 * scripts/set-alpaca-keys.js wrote every tool database and not data/keys.json
 * — the desk-wide pair that qp is given first. On 2026-09-24 that file held a
 * dead pair after the databases had been fixed, and the deploy kept saying
 * "rejected". The script now writes it too, keeping the other keys there.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'set-alpaca-keys.js');
const KEY = 'PKTESTNEWNEWNEWNEWNE';
const SECRET = 'secretNEWNEWNEWNEWNEWNEWNEW';

function run(dir) {
  // No .db in the folder: the script stops after keys.json, before touching
  // a database or asking Alpaca anything.
  return spawnSync(process.execPath, [SCRIPT, KEY, SECRET],
    { env: { ...process.env, DATA_DIR: dir, SHARED_KEYS_FILE: '' }, encoding: 'utf8' });
}

describe('set-alpaca-keys writes data/keys.json', () => {
  test('the dead pair is replaced and the Finnhub key is kept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-'));
    fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify(
      { finnhubApiKey: 'fh-test', alpacaApiKey: 'PKTESTOLDOLDOLDOLDOL', alpacaApiSecret: 'old' }));
    const r = run(dir);
    expect(r.stdout).toMatch(/keys\.json\s+updated/);
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8'));
    expect(j).toEqual({ finnhubApiKey: 'fh-test', alpacaApiKey: KEY, alpacaApiSecret: SECRET });
  });

  test('no file yet: it is created', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-'));
    run(dir);
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8'));
    expect(j.alpacaApiKey).toBe(KEY);
  });

  test('a file that does not parse is left alone, and said so', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-'));
    fs.writeFileSync(path.join(dir, 'keys.json'), '{ broken');
    const r = run(dir);
    expect(r.stdout).toMatch(/NOT CHANGED/);
    expect(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')).toBe('{ broken');
  });
});
