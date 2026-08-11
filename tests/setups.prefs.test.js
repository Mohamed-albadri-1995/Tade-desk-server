/*
 * Switching a setup off.
 *
 * A setup used to exist in the UI only in the moment it fired: there was no way
 * to see which setups there were, when they would run, or stop one. With more
 * than one that stops being cosmetic, so this is the state behind the list.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const FILE = path.join(os.tmpdir(), `setup-prefs-${process.pid}.json`);
process.env.SETUP_PREFS_FILE = FILE;

const prefs = require('../src/setups/prefs');

beforeEach(() => { try { fs.unlinkSync(FILE); } catch { /* absent */ } });
afterAll(() => { try { fs.unlinkSync(FILE); } catch { /* absent */ } });

/*
 * A deployed setup is meant to run. Requiring a file to exist first would make
 * a missing file indistinguishable from a broken scheduler.
 */
test('a setup nobody has touched is on', () => {
  expect(prefs.isEnabled('T2-VWAP-EXT')).toBe(true);
});

test('it can be switched off and stays off', () => {
  prefs.setEnabled('T2-VWAP-EXT', false);
  expect(prefs.isEnabled('T2-VWAP-EXT')).toBe(false);
});

test('and back on', () => {
  prefs.setEnabled('T2-VWAP-EXT', false);
  prefs.setEnabled('T2-VWAP-EXT', true);
  expect(prefs.isEnabled('T2-VWAP-EXT')).toBe(true);
});

test('switching one does not touch another', () => {
  prefs.setEnabled('A', false);
  prefs.setEnabled('B', true);
  expect(prefs.isEnabled('A')).toBe(false);
  expect(prefs.isEnabled('B')).toBe(true);
});

test('an unreadable file leaves everything on rather than everything off', () => {
  fs.writeFileSync(FILE, '{ not json');
  expect(prefs.isEnabled('T2-VWAP-EXT')).toBe(true);
});

/*
 * A count without a metric is a trap, not a preference.
 *
 * It takes n of an unordered list — the first n in card order — and looks
 * exactly like a working ranking. This is precisely the state T2 was left in
 * the moment the assumed metric was removed: topN 2, rankMetric null.
 */
test('a top-N without a metric is refused where it is typed', () => {
  expect(() => prefs.saveSettings('S', { topN: 2 }))
    .toThrow(/rank by before setting a count/);
  expect(() => prefs.saveSettings('S', { topN: 2, rankMetric: 'vwap_extension' }))
    .not.toThrow();
});

test('a metric alone is fine — that is "rank everything, take it all"', () => {
  expect(() => prefs.saveSettings('S2', { rankMetric: 'tight_stop' })).not.toThrow();
});

/* Clearing the metric while a count is still set must not slip through. */
test('removing the metric from a setup that has a count is refused', () => {
  prefs.saveSettings('S3', { topN: 3, rankMetric: 'rvol' });
  expect(() => prefs.saveSettings('S3', { rankMetric: null }))
    .toThrow(/rank by before setting a count/);
});
