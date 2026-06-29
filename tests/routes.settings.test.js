const request = require('supertest');
const express = require('express');

let mockDbRows = [];
let mockResetHotState = jest.fn();

jest.mock('../src/db', () => {
  const runMock = jest.fn();
  return {
    prepare: (sql) => ({
      all: () => mockDbRows,
      run: runMock,
      get: jest.fn(),
    }),
    transaction: (fn) => (...args) => fn(...args),
  };
});

jest.mock('../src/sideD/sectors', () => ({
  resetHotState: (...args) => mockResetHotState(...args),
}));

const settingsRouter = require('../src/routes/settings');

const app = express();
app.use(express.json());
app.use('/api/settings', settingsRouter);

beforeEach(() => {
  mockDbRows = [];
  mockResetHotState.mockClear();
});

// ─── GET /api/settings ────────────────────────────────────────────────────────
describe('GET /api/settings', () => {

  test('returns ok:true and settings object', async () => {
    mockDbRows = [
      { key: 'hotImmediateThreshold', value: '60' },
      { key: 'shortlistTopN', value: '5' },
    ];
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.settings).toHaveProperty('hotImmediateThreshold', '60');
    expect(res.body.settings).toHaveProperty('shortlistTopN', '5');
  });

  test('unknown keys in DB are filtered out', async () => {
    mockDbRows = [
      { key: 'someInternalKey', value: 'secret' },
      { key: 'shortlistTopN', value: '5' },
    ];
    const res = await request(app).get('/api/settings');
    expect(res.body.settings).not.toHaveProperty('someInternalKey');
    expect(res.body.settings).toHaveProperty('shortlistTopN');
  });

  test('finnhubApiKey with value → returns "set" (masked)', async () => {
    mockDbRows = [{ key: 'finnhubApiKey', value: 'sk-abc123' }];
    const res = await request(app).get('/api/settings');
    expect(res.body.settings.finnhubApiKey).toBe('set');
  });

  test('finnhubApiKey empty → returns ""', async () => {
    mockDbRows = [{ key: 'finnhubApiKey', value: '' }];
    const res = await request(app).get('/api/settings');
    expect(res.body.settings.finnhubApiKey).toBe('');
  });

  test('finnhubApiKey null → returns ""', async () => {
    mockDbRows = [{ key: 'finnhubApiKey', value: null }];
    const res = await request(app).get('/api/settings');
    expect(res.body.settings.finnhubApiKey).toBe('');
  });
});

// ─── POST /api/settings ───────────────────────────────────────────────────────
describe('POST /api/settings', () => {

  test('valid int setting → 200 ok', async () => {
    const res = await request(app)
      .post('/api/settings')
      .send({ hotImmediateThreshold: 75 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.saved).toContain('hotImmediateThreshold');
  });

  test('multiple valid settings saved together', async () => {
    const res = await request(app)
      .post('/api/settings')
      .send({ shortlistMinScore: 80, shortlistTopN: 3 });
    expect(res.status).toBe(200);
    expect(res.body.saved).toHaveLength(2);
  });

  test('unknown key → 400 with error', async () => {
    const res = await request(app)
      .post('/api/settings')
      .send({ injectSomething: 'evil' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.errors[0]).toMatch(/Unknown key/);
  });

  test('value out of range → 400', async () => {
    const res = await request(app)
      .post('/api/settings')
      .send({ hotImmediateThreshold: 200 }); // max is 100
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatch(/hotImmediateThreshold/);
  });

  test('non-integer for int field → 400', async () => {
    const res = await request(app)
      .post('/api/settings')
      .send({ shortlistTopN: 2.5 });
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatch(/integer/);
  });

  test('sectorBearishThreshold accepts negative values', async () => {
    const res = await request(app)
      .post('/api/settings')
      .send({ sectorBearishThreshold: -30 });
    expect(res.status).toBe(200);
    expect(res.body.saved).toContain('sectorBearishThreshold');
  });

  test('sectorBearishThreshold positive value → 400 (max is 0)', async () => {
    const res = await request(app)
      .post('/api/settings')
      .send({ sectorBearishThreshold: 10 });
    expect(res.status).toBe(400);
  });

  test('finnhubApiKey string accepted', async () => {
    const res = await request(app)
      .post('/api/settings')
      .send({ finnhubApiKey: 'mykey123' });
    expect(res.status).toBe(200);
    expect(res.body.saved).toContain('finnhubApiKey');
  });

  test('finnhubApiKey exceeding maxLen → 400', async () => {
    const res = await request(app)
      .post('/api/settings')
      .send({ finnhubApiKey: 'a'.repeat(101) });
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatch(/finnhubApiKey/);
  });

  test('empty body → 400', async () => {
    const res = await request(app)
      .post('/api/settings')
      .send([]);  // array is invalid
    expect(res.status).toBe(400);
  });

  test('boundary value at min is valid', async () => {
    const res = await request(app)
      .post('/api/settings')
      .send({ shortlistTopN: 1 }); // min is 1
    expect(res.status).toBe(200);
  });

  test('boundary value at max is valid', async () => {
    const res = await request(app)
      .post('/api/settings')
      .send({ shortlistTopN: 50 }); // max is 50
    expect(res.status).toBe(200);
  });
});

// ─── POST /api/settings/reset-hot ─────────────────────────────────────────────
describe('POST /api/settings/reset-hot', () => {

  test('calls resetHotState and returns ok', async () => {
    const res = await request(app).post('/api/settings/reset-hot');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockResetHotState).toHaveBeenCalledTimes(1);
  });

  test('response includes a message', async () => {
    const res = await request(app).post('/api/settings/reset-hot');
    expect(res.body).toHaveProperty('message');
    expect(typeof res.body.message).toBe('string');
  });
});
