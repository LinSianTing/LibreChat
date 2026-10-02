const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createCentralSSO } = require('../api/server/services/LocalCentralSSO');

/** Optional isolated test tools; without this variable use the installed workspace dependencies. */
const dependencies = process.env.OPENSCHOOL_TEST_MODULES
  ? createRequire(path.resolve(process.env.OPENSCHOOL_TEST_MODULES, 'package.json'))
  : require;
const jwt = dependencies('jsonwebtoken');
const express = dependencies('express');
const cors = dependencies('cors');
const ts = dependencies('typescript');
const env = {
  OPENSCHOOL_CENTRAL_SSO: 'true',
  NODE_ENV: 'development',
  OPENID_ISSUER: 'http://localhost:15480/realms/langrace-local',
  OPENID_CLIENT_ID: 'chat-local',
  OPENSCHOOL_CENTRAL_API_URL: 'http://localhost:15481',
  OPENSCHOOL_CENTRAL_API_KEY: 'test-only',
  JWT_SECRET: 'logout-test-signing-secret',
  DOMAIN_CLIENT: 'http://localhost:15483',
  DOMAIN_SERVER: 'http://localhost:15483',
};
const sessionA = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const sessionB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const binding = () => ({
  reference: '01900000-0000-7000-8000-000000000001',
  issuer: env.OPENID_ISSUER,
  clientId: 'chat-local',
  subject: 'subject-a',
  sid: 'keycloak-a',
  memberId: '01900000-0000-7000-8000-000000000002',
  chatOwnerId: '1234567890abcdef12345678',
  expiresAtUtc: new Date(Date.now() + 3600000).toISOString(),
});
const payload = (central = binding()) => ({
  id: central.chatOwnerId,
  sessionId: sessionA,
  centralSession: central,
  exp: Math.floor(Date.now() / 1000) + 600,
});
const sign = (value = payload(), key = env.JWT_SECRET, algorithm = 'HS256') =>
  jwt.sign(value, key, { algorithm });
const pass = (_req, _res, next) => next();
const logger = { warn() {}, error() {}, info() {}, debug() {} };

/** Execute production hook bodies, substituting only unavailable workspace/DB services. */
function load(relative, supplied, isTypeScript = false) {
  const filename = path.join(__dirname, '..', relative);
  const module = { exports: {} };
  let source = fs.readFileSync(filename, 'utf8');
  if (isTypeScript) {
    source = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }
  vm.runInNewContext(
    source,
    {
      module,
      exports: module.exports,
      process: { env },
      URL,
      require(name) {
        if (Object.hasOwn(supplied, name)) return supplied[name];
        return {};
      },
    },
    { filename },
  );
  return module.exports;
}

async function fixture(t, { expired = false, localMissing = false, enabled = true } = {}) {
  const central = binding();
  if (expired) central.expiresAtUtc = new Date(Date.now() - 3600000).toISOString();
  const sessions = new Set(localMissing ? [sessionB] : [sessionA, sessionB]);
  const browserSessions = new Set(['A', 'B']);
  const calls = [];
  const deletes = [];
  let revokeStatus = 204;
  let protectedCalls = 0;
  const service = createCentralSSO({
    env: { ...env, OPENSCHOOL_CENTRAL_SSO: String(enabled) },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
      if (!url.endsWith('/revoke')) throw new Error('Live validation/IdP is unavailable');
      if (revokeStatus === 'network') throw new Error('Web is unavailable');
      return { status: revokeStatus };
    },
  });
  const deleteSession = async ({ sessionId }) => {
    deletes.push(sessionId);
    return { deletedCount: sessions.delete(sessionId) ? 1 : 0 };
  };
  const { createSameOriginGuard } = load(
    'packages/api/src/middleware/origin.ts',
    {
      '@librechat/data-schemas': { logger },
      'librechat-data-provider': { ErrorTypes: { AUTH_CROSS_ORIGIN: 'AUTH_CROSS_ORIGIN' } },
    },
    true,
  );
  const requireSameOrigin = load('api/server/middleware/requireSameOrigin.js', {
    '@librechat/api': { createSameOriginGuard },
  });
  const controller = load('api/server/controllers/auth/LogoutController.js', {
    jsonwebtoken: jwt,
    '~/server/services/LocalCentralSSO': service,
    '~/models': { deleteSession },
    '@librechat/api': { clearCloudFrontCookies: (res) => res.clearCookie('cf-auth') },
    '@librechat/data-schemas': { logger },
  });
  const middleware = new Proxy(
    {
      requireSameOrigin,
      requireJwtAuth: (_req, res) => {
        protectedCalls++;
        return res.status(401).json({ message: 'ordinary protected auth refused' });
      },
    },
    { get: (target, key) => target[key] ?? pass },
  );
  const router = load('api/server/routes/auth.js', {
    express,
    '~/server/services/LocalCentralSSO': service,
    '@librechat/api': { createSetBalanceConfig: () => pass },
    '~/server/controllers/AuthController': new Proxy({}, { get: () => pass }),
    '~/server/controllers/TwoFactorController': new Proxy({}, { get: () => pass }),
    '~/server/controllers/auth/TwoFactorAuthController': { verify2FAWithTempToken: pass },
    '~/server/controllers/auth/LoginController': { loginController: pass },
    '~/server/controllers/auth/LogoutController': controller,
    '~/server/middleware': middleware,
  });
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, res, next) => {
    const browser = req.headers.cookie?.includes('browser=B') ? 'B' : 'A';
    req.session = {
      destroy(done) {
        browserSessions.delete(browser);
        done();
      },
    };
    res.on('finish', () => {
      assert.equal(req.user, undefined, 'logout-only credential must never become req.user');
      assert.equal(req.centralSessionId, undefined);
    });
    next();
  });
  app.use('/api/auth', router);
  app.use((_req, res) => res.sendStatus(404));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (
    token,
    { route = '/api/auth/logout', method = 'POST', headers = {}, body } = {},
  ) =>
    fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Origin: env.DOMAIN_CLIENT,
        Cookie: 'browser=A',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return {
    central,
    service,
    sessions,
    browserSessions,
    calls,
    deletes,
    request,
    setRevokeStatus: (status) => {
      revokeStatus = status;
    },
    protectedCalls: () => protectedCalls,
  };
}

test('expired JWT and binding revoke even after Mongo TTL cleanup; repeated logout is idempotent', async (t) => {
  const f = await fixture(t, { expired: true, localMissing: true });
  const token = sign({ ...payload(f.central), exp: 1 });
  assert.throws(() => jwt.verify(token, env.JWT_SECRET), /jwt expired/);
  for (let i = 0; i < 2; i++) {
    const result = await f.request(token);
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(body.code, 'CENTRAL_LOGOUT_BROWSER_MISMATCH');
    assert.equal(body.redirect, undefined);
    assert.deepEqual(result.headers.getSetCookie(), []);
  }
  assert.equal(f.calls.length, 2);
  assert.ok(
    f.calls.every(
      (call) => call.url.endsWith('/revoke') && call.body.reference === f.central.reference,
    ),
  );
  assert.deepEqual(f.deletes, [sessionA, sessionA]);
  assert.deepEqual([...f.sessions], [sessionB]);
  assert.deepEqual([...f.browserSessions], ['A', 'B']);
});

test('live-check/IdP outage is never consulted for a valid logout-only signature', async (t) => {
  const f = await fixture(t);
  const result = await f.request(sign(payload(f.central)));
  assert.equal(result.status, 200);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].url.endsWith('/revoke'));
  assert.equal(f.calls[0].headers['X-OpenSchool-Central-Key'], env.OPENSCHOOL_CENTRAL_API_KEY);
});

for (const failure of [503, 401, 'network']) {
  test(`revoke ${failure} returns 503 without clearing local/browser state; same expired token retries`, async (t) => {
    const f = await fixture(t, { expired: true });
    const token = sign({ ...payload(f.central), exp: 1 });
    f.setRevokeStatus(failure);
    const failed = await f.request(token);
    assert.equal(failed.status, 503);
    assert.deepEqual(failed.headers.getSetCookie(), []);
    assert.equal(f.sessions.has(sessionA), true);
    assert.equal(f.browserSessions.has('A'), true);
    assert.deepEqual(f.deletes, []);
    f.setRevokeStatus(204);
    assert.equal((await f.request(token)).status, 200);
    assert.deepEqual([...f.sessions], [sessionB]);
    assert.deepEqual([...f.browserSessions], ['A', 'B']);
  });
}

test('real JWT verification rejects forged signature, wrong algorithm, unsigned token and malformed signed bindings', async (t) => {
  const f = await fixture(t);
  const good = payload(f.central);
  const invalid = [
    sign(good, 'attacker-secret'),
    sign(good, env.JWT_SECRET, 'HS384'),
    jwt.sign(good, null, { algorithm: 'none' }),
    sign({ ...good, id: 'bbbbbbbbbbbbbbbbbbbbbbbb' }),
    sign({ ...good, sessionId: 'invalid' }),
    sign({ ...good, sessionId: [sessionA] }),
    sign({ ...good, centralSession: { ...f.central, reference: 'invalid' } }),
    sign({ ...good, centralSession: { ...f.central, reference: [f.central.reference] } }),
    sign({ ...good, centralSession: { ...f.central, expiresAtUtc: 'invalid' } }),
    sign({ id: good.id, sessionId: sessionA, exp: 1 }),
    sign({ id: good.id, sessionId: sessionA, centralSession: f.central }),
  ];
  for (const token of invalid) {
    const result = await f.request(token);
    assert.equal(result.status, 401);
    assert.deepEqual(result.headers.getSetCookie(), []);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.deletes, []);
  assert.equal(f.protectedCalls(), 0);
});

test('body/query/cookie credentials cannot impersonate Bearer; forged values cannot override a signed reference', async (t) => {
  const f = await fixture(t);
  const token = sign(payload(f.central));
  for (const options of [
    { body: { token, reference: f.central.reference } },
    { route: `/api/auth/logout?token=${token}` },
    { headers: { Cookie: `token_provider=openid; refreshToken=${token}` } },
    { headers: { Authorization: `Basic ${token}` } },
    { headers: { Authorization: `Bearer ${token}, Bearer ${token}` } },
  ])
    assert.equal((await f.request(null, options)).status, 401);
  assert.deepEqual(f.calls, []);
  const result = await f.request(token, {
    route: '/api/auth/logout?sessionId=bbbbbbbbbbbbbbbbbbbbbbbb',
    body: { memberId: 'forged', reference: 'forged', sessionId: sessionB },
  });
  assert.equal(result.status, 200);
  assert.equal(f.calls[0].body.reference, f.central.reference);
  assert.deepEqual(f.deletes, [sessionA]);
});

test('precise POST logout boundary retains Origin/CSRF checks and other protected routes', async (t) => {
  const f = await fixture(t);
  const token = sign({ ...payload(f.central), exp: 1 });
  for (const headers of [
    { Origin: 'https://evil.invalid', 'Sec-Fetch-Site': 'cross-site' },
    { Origin: 'https://evil.invalid' },
    { Origin: 'null' },
  ])
    assert.equal((await f.request(token, { headers })).status, 403);
  for (const options of [
    { method: 'GET' },
    { method: 'DELETE' },
    { route: '/api/auth/logout/' },
    { route: '/api/auth/Logout' },
    { route: '/api/auth/logout/extra' },
    { route: '/api/auth/cloudfront/refresh' },
  ])
    assert.notEqual((await f.request(token, options)).status, 200);
  const preflight = await f.request(null, {
    method: 'OPTIONS',
    headers: {
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization',
    },
  });
  assert.equal(preflight.status, 204);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.deletes, []);
});

test('logout expiration allowance does not weaken authorize, refresh or validate', async () => {
  const central = { ...binding(), expiresAtUtc: new Date(0).toISOString() };
  const service = createCentralSSO({
    env,
    fetchImpl: () => assert.fail('expired credentials must fail before HTTP'),
  });
  const stored = { user: central.chatOwnerId, centralSession: central };
  assert.throws(() => service.binding(central));
  await assert.rejects(() => service.validate(central));
  await assert.rejects(() =>
    service.authorize(
      payload(central),
      { _id: central.chatOwnerId, role: 'USER' },
      async () => stored,
    ),
  );
  await assert.rejects(() =>
    service.prepareTokens(central.chatOwnerId, stored, {}, async () =>
      assert.fail('no user reload'),
    ),
  );
});

test('feature off keeps ordinary protected authentication on logout', async (t) => {
  const f = await fixture(t, { enabled: false });
  assert.equal((await f.request(sign({ ...payload(f.central), exp: 1 }))).status, 401);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.deletes, []);
  assert.equal(f.protectedCalls(), 1);
});
