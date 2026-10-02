const express = require('express');
const request = require('supertest');
jest.mock('~/server/services/LocalCentralSSO', () => ({
  enabled: () => process.env.OPENSCHOOL_CENTRAL_SSO === 'true',
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => (req.user ? next() : res.sendStatus(401)),
  requireSameOrigin: jest.requireActual('@librechat/api').createSameOriginGuard({
    trustedOrigins: ['http://chat.test', 'https://chat.test'],
  }),
}));
const router = require('../openschool');
const id = 'a'.repeat(64);
const url = 'http://web.test/ai-gateway/v1/prompt-handoff/consume';
const originalFetch = global.fetch;
const originalEnv = { ...process.env };
let mockFetch;

function app(user = { id: 'member', googleId: 'google-owner' }) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.user = user;
    next();
  });
  server.use('/api/openschool', router);
  return server;
}
function post(user) {
  return request(app(user)).post('/api/openschool/handoff').set('Origin', 'http://chat.test');
}
function payload(overrides = {}) {
  return {
    prompt: 'Private text',
    model: 'personal',
    expiresAtUtc: new Date(Date.now() + 60000).toISOString(),
    ...overrides,
  };
}
function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  process.env.OPENSCHOOL_PROMPT_HANDOFF_ENABLED = 'true';
  process.env.OPENSCHOOL_HANDOFF_GATEWAY_URL = url;
  process.env.OPENSCHOOL_HANDOFF_GATEWAY_KEY = 'server-only-test-key';
  process.env.DOMAIN_CLIENT = 'http://chat.test';
  mockFetch = jest.fn().mockResolvedValue(response(payload()));
  global.fetch = mockFetch;
});
afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = originalFetch;
  jest.useRealTimers();
});

test('anonymous is rejected before consume', async () => {
  expect((await post(null).send({ id })).status).toBe(401);
  expect(mockFetch).not.toHaveBeenCalled();
});
test('central handoff derives both identifiers only from authenticated user', async () => {
  process.env.OPENSCHOOL_CENTRAL_SSO = 'true';
  const user = {
    memberId: '11111111-1111-7111-8111-111111111111',
    centralSessionReference: '22222222-2222-7222-8222-222222222222',
  };
  const result = await post(user).set('X-OpenSchool-Member-Id', 'forged').send({ id });
  expect(result.status).toBe(200);
  const headers = mockFetch.mock.calls[0][1].headers;
  expect(headers['X-OpenSchool-Member-Id']).toBe(user.memberId);
  expect(headers['X-OpenSchool-Central-Session']).toBe(user.centralSessionReference);
  expect(headers['X-OpenSchool-Google-Sub']).toBeUndefined();
  expect((await post({ googleId: 'legacy-only' }).send({ id })).status).toBe(403);
});
test.each([{}, { googleId: '' }, { googleId: 'bad\r\nsubject' }])(
  'missing/unsafe Google identity is refused',
  async (user) => {
    expect((await post(user).send({ id })).status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  },
);
test('forwards only req.user identity and server configuration; success is no-store', async () => {
  const result = await post().set('X-OpenSchool-Google-Sub', 'attacker').send({ id });
  expect(result.status).toBe(200);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.body).toEqual(payload({ expiresAtUtc: result.body.expiresAtUtc }));
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockFetch).toHaveBeenCalledWith(
    url,
    expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({ id }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer server-only-test-key',
        'X-OpenSchool-Google-Sub': 'google-owner',
      },
    }),
  );
});
test('other logged-in account reaches Web as itself, not the draft owner', async () => {
  mockFetch.mockResolvedValue(response({ prompt: 'Never relay error details' }, 403));
  const result = await post({ id: 'other', googleId: 'other-google-sub' }).send({ id });
  expect(mockFetch.mock.calls[0][1].headers['X-OpenSchool-Google-Sub']).toBe('other-google-sub');
  expect(result.status).toBe(403);
  expect(result.body).toEqual({ code: 'OPENSCHOOL_HANDOFF_FAILED' });
});
test('https deployment sets forwarding scheme only from server config', async () => {
  process.env.DOMAIN_CLIENT = 'https://chat.test';
  const result = await request(app())
    .post('/api/openschool/handoff')
    .set('Origin', 'https://chat.test')
    .set('X-Forwarded-Proto', 'http')
    .send({ id });
  expect(result.status).toBe(200);
  expect(mockFetch.mock.calls[0][1].headers['X-Forwarded-Proto']).toBe('https');
});
test.each([
  { id, subject: 'attacker' },
  { id, url: 'http://evil.test' },
  { id, key: 'evil' },
  { id: 'A'.repeat(64) },
  { id: 'x' },
  {},
])('rejects browser identity/config and invalid IDs', async (body) => {
  expect((await post().send(body)).status).toBe(400);
  expect(mockFetch).not.toHaveBeenCalled();
});
test.each(['http://evil.test', 'null', 'http://chat.test.evil'])(
  'cross-site origin %s is refused',
  async (origin) => {
    const result = await request(app())
      .post('/api/openschool/handoff')
      .set('Origin', origin)
      .set('Sec-Fetch-Site', 'same-origin')
      .send({ id });
    expect(result.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  },
);
test('missing origin is refused', async () => {
  expect((await request(app()).post('/api/openschool/handoff').send({ id })).status).toBe(403);
  expect(mockFetch).not.toHaveBeenCalled();
});
test.each([undefined, 'false', '1'])('flag defaults off (%s)', async (value) => {
  delete process.env.OPENSCHOOL_PROMPT_HANDOFF_ENABLED;
  if (value) {
    process.env.OPENSCHOOL_PROMPT_HANDOFF_ENABLED = value;
  }
  expect((await post().send({ id })).status).toBe(404);
  expect(mockFetch).not.toHaveBeenCalled();
});
test.each([400, 403, 404, 503, 500, 302])(
  'safe upstream failure %s without its body',
  async (status) => {
    mockFetch.mockResolvedValue(response({ prompt: 'secret-error', key: 'secret' }, status));
    const result = await post().send({ id });
    expect(result.status).toBe([400, 403, 404, 503].includes(status) ? status : 503);
    expect(JSON.stringify(result.body)).not.toContain('secret');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  },
);
test.each([
  { prompt: 'x'.repeat(6001) },
  { prompt: '' },
  { model: 'other' },
  { expiresAtUtc: new Date(0).toISOString() },
  { expiresAtUtc: 'invalid' },
  { expiresAtUtc: new Date(Date.now() + 3600000).toISOString() },
])('refuses invalid/expired Web payload', async (overrides) => {
  mockFetch.mockResolvedValue(response(payload(overrides)));
  expect((await post().send({ id })).status).toBe(404);
});
test('accepts exactly 6000 UTF-16 characters and circle models', async () => {
  mockFetch.mockResolvedValue(
    response(payload({ prompt: '字'.repeat(6000), model: 'circle-adult' })),
  );
  expect((await post().send({ id })).status).toBe(200);
});
test('caps response bytes', async () => {
  mockFetch.mockResolvedValue(response(payload({ unexpected: 'x'.repeat(70000) })));
  expect((await post().send({ id })).status).toBe(503);
});
test('network failure does not retry or reveal exception content', async () => {
  mockFetch.mockRejectedValue(new Error('secret-prompt-or-key'));
  const result = await post().send({ id });
  expect(result.status).toBe(503);
  expect(JSON.stringify(result.body)).not.toContain('secret');
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
test('timeout aborts the single request', async () => {
  mockFetch.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  );
  const result = await post().send({ id });
  expect(result.status).toBe(503);
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
}, 10000);
test.each([
  'http://user:password@web.test/ai-gateway/v1/prompt-handoff/consume',
  'http://web.test/wrong',
  'http://web.test/ai-gateway/v1/prompt-handoff/consume?q=secret',
])('rejects unsafe gateway config', async (value) => {
  process.env.OPENSCHOOL_HANDOFF_GATEWAY_URL = value;
  expect((await post().send({ id })).status).toBe(503);
  expect(mockFetch).not.toHaveBeenCalled();
});
