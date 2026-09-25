/*
 * HOW LONG AFTER THE MINUTE THE DESK DECIDES (2026-09-25).
 *
 * The first real Check found live reading Yahoo's just-closed bar about a
 * second after it closed, before Yahoo had finished it (SNX's 09:42 close
 * 279.37 live, 279.65 final). The decision and the manager now wait
 * `settleSec` from the minute. 10 by default, 0-40.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
const broker = require('../src/broker/signalstack');

afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('10 seconds when nothing is set', () => {
  expect(broker.settleSecOf(undefined)).toBe(10);
  expect(broker.settings().settleSec).toBe(10);
});

test('clamped to 0-40, whole seconds', () => {
  expect(broker.settleSecOf(0)).toBe(0);
  expect(broker.settleSecOf(15.4)).toBe(15);
  expect(broker.settleSecOf(99)).toBe(40);
  expect(broker.settleSecOf('abc')).toBe(10);
});

test('saved from the page, and a nonsense value refused', () => {
  broker.save({ settleSec: 15 });
  expect(broker.settings().settleSec).toBe(15);
  expect(() => broker.save({ settleSec: 90 })).toThrow(/between 0 and 40/);
  broker.save({ settleSec: '' });
  expect(broker.settings().settleSec).toBe(10);
});

test('the decision tick waits for it before deciding', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'scheduler.js'), 'utf8');
  const wait = src.indexOf('const settleMs = settleWaitMs(minuteStart)');
  const decide = src.indexOf('ran = await runDue(decidedOn)');
  expect(wait).toBeGreaterThan(0);
  expect(wait).toBeLessThan(decide);
});
