/*
 * An unknown /api path must not return the landing page.
 *
 * The SPA fallback serves home.html for anything unmatched, which is right for
 * a browser URL and wrong for an API call: the caller gets HTTP 200 and a page
 * of HTML where it asked for data. That is exactly what happened when the
 * TradingView export was called against a server that had not been restarted
 * yet — the fetch succeeded, `r.ok` was true, and the entire landing page went
 * to the clipboard as a "watchlist".
 *
 * The whole app is mounted here rather than one router, because the bug lives
 * in the ORDER of the handlers: any test that mounted the routers alone would
 * pass while the deployed server kept serving HTML.
 */

process.env.DB_PATH = require('path').join(require('os').tmpdir(), `api404-${process.pid}.db`);
process.env.TOOL_ID = 'T1';

const request = require('supertest');

// src/index.js only listens when it is the program being run, so requiring it
// here yields the configured app and binds nothing. supertest starts its own
// ephemeral server per request.

let app;
beforeAll(() => {
  app = require('../src/index');
});

afterAll(() => {
  jest.restoreAllMocks();
  for (const suffix of ['', '-wal', '-shm']) {
    try { require('fs').unlinkSync(process.env.DB_PATH + suffix); } catch { /* gone */ }
  }
});

describe('unknown API endpoints 404 rather than serving HTML', () => {
  test('a path under /api that nothing claims is a JSON 404', async () => {
    const r = await request(app).get('/api/does/not/exist');
    expect(r.status).toBe(404);
    expect(r.headers['content-type']).toMatch(/json/);
    expect(r.body).toEqual(expect.objectContaining({ ok: false, error: 'No such endpoint' }));
  });

  test('it names the path, so the caller sees what it actually asked for', async () => {
    const r = await request(app).get('/api/shortlist/all-tools/exprot');   // typo on purpose
    expect(r.body.path).toBe('/api/shortlist/all-tools/exprot');
  });

  test('the response is never HTML, whatever the path looks like', async () => {
    // The failure being guarded against is a body that parses as a page. Any
    // 200 with markup here is the original bug returning.
    for (const p of ['/api/', '/api/x', '/api/shortlist/nope', '/api/canslim/members']) {
      const r = await request(app).get(p);
      expect({ p, html: /<!DOCTYPE|<html/i.test(r.text || '') }).toEqual({ p, html: false });
    }
  });

  test('a real API endpoint is untouched', async () => {
    const r = await request(app).get('/api/tools');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  test('the TradingView export answers as text, not as a page', async () => {
    const r = await request(app).get('/api/shortlist/all-tools/export?format=csv');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/plain/);
    expect(/<!DOCTYPE|<html/i.test(r.text || '')).toBe(false);
  });

  test('a browser URL still gets the page — the fallback is only narrowed for /api', async () => {
    // Narrowing this too far would break deep links into the scanner, which is
    // the reason the catch-all exists in the first place.
    for (const p of ['/some/deep/link', '/scanner', '/scanner/anything']) {
      const r = await request(app).get(p);
      expect({ p, status: r.status, html: /<!DOCTYPE|<html/i.test(r.text || '') })
        .toEqual({ p, status: 200, html: true });
    }
  });
});
