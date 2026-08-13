/*
 * ONE STYLESHEET, TWO SERVERS.
 *
 * qp is a separate program — Python, its own port, its own static directory —
 * so it cannot <link> the screener's stylesheet without going cross-origin and
 * failing to load whenever the screener is down. A charting tool that renders
 * unstyled because a different service is restarting is worse than a copy.
 *
 * So it is a copy, and this is what stops it becoming a fork. The two files
 * must be byte-identical; `cp public/desk.css quant-platform/chart/static/`
 * is the fix when this fails.
 */
const fs = require('fs');
const path = require('path');

const A = path.join(__dirname, '..', 'public', 'desk.css');
const B = path.join(__dirname, '..', 'quant-platform', 'chart', 'static', 'desk.css');

test('qp carries the same design system, byte for byte', () => {
  const a = fs.readFileSync(A, 'utf8');
  const b = fs.readFileSync(B, 'utf8');
  expect({ same: a === b, fix: a === b ? 'ok'
    : 'run: cp public/desk.css quant-platform/chart/static/desk.css' })
    .toEqual({ same: true, fix: 'ok' });
});

test('and it is the real system, not a stub', () => {
  const b = fs.readFileSync(B, 'utf8');
  for (const t of ['--m-up', '--text3', 'body.sunlight', '--f-lg', '--s3']) {
    expect({ token: t, on: b.includes(t) }).toEqual({ token: t, on: true });
  }
});
