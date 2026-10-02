const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const session = require('express-session');
const jwt = require('jsonwebtoken');
const ts = require('typescript');
const { createCentralSSO } = require('../api/server/services/LocalCentralSSO');
const root = '/api/auth/central-logout';
const env = {
  OPENSCHOOL_CENTRAL_SSO: 'true',
  NODE_ENV: 'development',
  OPENID_ISSUER: 'http://localhost:15480/realms/langrace-local',
  OPENID_CLIENT_ID: 'chat-local',
  OPENSCHOOL_CENTRAL_API_URL: 'http://localhost:15481',
  OPENSCHOOL_CENTRAL_API_KEY: 'synthetic',
  JWT_SECRET: 'synthetic-access',
  JWT_REFRESH_SECRET: 'synthetic-refresh',
  DOMAIN_CLIENT: 'http://localhost:15483',
  DOMAIN_SERVER: 'http://localhost:15483',
};
const logger = { warn() {}, error() {}, info() {}, debug() {} };
const pass = (_req, _res, next) => next();
const fallback = new Proxy({}, { get: () => pass });
function load(relative, supplied, typescript = false) {
  const filename = path.join(__dirname, '..', relative);
  let source = fs.readFileSync(filename, 'utf8');
  if (typescript)
    source = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    source,
    {
      module,
      exports: module.exports,
      process: { env },
      URL,
      require: (name) => supplied[name] ?? {},
    },
    { filename },
  );
  return module.exports;
}
async function fixture(t) {
  const central = (suffix) => ({
    reference: `01900000-0000-7000-8000-00000000000${suffix}`,
    issuer: env.OPENID_ISSUER,
    clientId: 'chat-local',
    subject: 'same-person',
    sid: `sid-${suffix}`,
    memberId: '01900000-0000-7000-8000-000000000009',
    chatOwnerId: '1234567890abcdef12345678',
    expiresAtUtc: new Date(Date.now() + 300000).toISOString(),
  });
  const a = central('1');
  const b = central('2');
  const ids = { A: 'aaaaaaaaaaaaaaaaaaaaaaaa', B: 'bbbbbbbbbbbbbbbbbbbbbbbb' };
  const bindings = { A: a, B: b };
  const locals = new Set(Object.values(ids));
  const revoked = new Set();
  const calls = [];
  const deleted = [];
  let unavailable = false;
  const service = createCentralSSO({
    env,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      if (!url.endsWith('/revoke'))
        assert.fail('Logout must never validate/register or extend lifetime');
      if (unavailable) return { status: 503 };
      revoked.add(body.reference);
      return { status: 204 };
    },
  });
  const deleteSession = async ({ sessionId }) => {
    deleted.push(sessionId);
    locals.delete(sessionId);
  };
  const { createSameOriginGuard } = load(
    'packages/api/src/middleware/origin.ts',
    {
      '@librechat/data-schemas': { logger },
      'librechat-data-provider': { ErrorTypes: { AUTH_CROSS_ORIGIN: 'AUTH_CROSS_ORIGIN' } },
    },
    true,
  );
  const requireSameOrigin = createSameOriginGuard({ trustedOrigins: [env.DOMAIN_CLIENT] });
  const controller = load('api/server/controllers/auth/LogoutController.js', {
    jsonwebtoken: jwt,
    '~/server/services/LocalCentralSSO': service,
    '~/models': { deleteSession },
    '@librechat/data-schemas': { logger },
    '@librechat/api': {
      clearCloudFrontCookies: () => assert.fail('Must not clear shared cookie names'),
    },
  });
  const router = load('api/server/routes/auth.js', {
    express,
    jsonwebtoken: jwt,
    '~/models': { deleteSession },
    '~/server/services/LocalCentralSSO': service,
    '@librechat/api': { createSetBalanceConfig: () => pass },
    '~/server/controllers/AuthController': fallback,
    '~/server/controllers/TwoFactorController': fallback,
    '~/server/controllers/auth/TwoFactorAuthController': fallback,
    '~/server/controllers/auth/LoginController': fallback,
    '~/server/controllers/auth/LogoutController': controller,
    '~/server/middleware': new Proxy(
      { requireSameOrigin },
      { get: (obj, key) => obj[key] ?? pass },
    ),
  });
  const store = new session.MemoryStore();
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'synthetic-browser-secret',
      store,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', maxAge: 600000 },
    }),
  );
  // Test-only replacement for the already-verified callback; production save/regenerate/store run.
  app.post('/seed/:who', async (req, res) => {
    const who = req.params.who;
    await service.saveLogoutBinding(req, ids[who], bindings[who], `original-id-token-${who}`);
    res.json({ sessionId: req.sessionID });
  });
  app.use('/api/auth', router);
  app.use(
    '/oauth',
    load('api/server/routes/oauth.js', {
      express,
      passport: {
        authenticate: (_name, _options, callback) =>
          callback
            ? (_req, _res) => callback(new Error('synthetic expired registration'), false)
            : pass,
      },
      'openid-client': { randomState: () => 'synthetic-state' },
      '~/server/services/LocalCentralSSO': service,
      '@librechat/data-schemas': { logger },
      'librechat-data-provider': { ErrorTypes: { AUTH_FAILED: 'auth_failed' } },
      '@librechat/api': {
        createSetBalanceConfig: () => pass,
        createOpenIDCallbackAuthenticator: () => pass,
      },
      '~/server/middleware': fallback,
      '~/server/controllers/auth/oauth': {
        createOAuthHandler: () => () => assert.fail('Failed callback cannot issue a session'),
      },
      '~/models': {},
      '~/server/services/Config': {},
    }),
  );
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (
    route,
    { cookie, token, method = 'GET', body, origin = env.DOMAIN_CLIENT } = {},
  ) =>
    fetch(base + route, {
      method,
      redirect: 'manual',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(body ? { body: new URLSearchParams(body) } : {}),
    });
  const seed = async (who, previousCookie) => {
    const response = await request(`/seed/${who}`, { method: 'POST', cookie: previousCookie });
    assert.equal(response.status, 200);
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith('connect.sid='))
      .split(';')[0];
    return { cookie, id: (await response.json()).sessionId };
  };
  const read = (id) =>
    new Promise((resolve, reject) => store.get(id, (e, value) => (e ? reject(e) : resolve(value))));
  const write = (id, value) =>
    new Promise((resolve, reject) => store.set(id, value, (e) => (e ? reject(e) : resolve())));
  const signed = (who, secret = env.JWT_SECRET, exp = 1) =>
    jwt.sign(
      {
        id: bindings[who].chatOwnerId,
        sessionId: ids[who],
        centralSession: bindings[who],
        exp,
      },
      secret,
      { algorithm: 'HS256' },
    );
  const originalA = await seed('A');
  const originalB = await seed('B');
  const form = async (cookie) => {
    const response = await request(root, { cookie });
    assert.equal(response.status, 200);
    assert.deepEqual(response.headers.getSetCookie(), []);
    const text = await response.text();
    assert.ok(!text.includes('original-id-token'));
    return /name="state" value="([a-f0-9]{64})"/.exec(text)[1];
  };
  const start = async (cookie, state) => {
    const response = await request(root + '/continue', { method: 'POST', cookie, body: { state } });
    assert.equal(response.status, 303);
    assert.deepEqual(response.headers.getSetCookie(), []);
    const location = new URL(response.headers.get('location'));
    assert.equal(location.origin, 'http://localhost:15480');
    assert.equal(
      location.searchParams.get('post_logout_redirect_uri'),
      `http://localhost:15483${root}/callback`,
    );
    return location;
  };
  return {
    a,
    b,
    locals,
    ids,
    calls,
    deleted,
    revoked,
    request,
    read,
    write,
    signed,
    seed,
    form,
    start,
    A: originalA,
    B: originalB,
    setUnavailable: (value) => {
      unavailable = value;
    },
  };
}

test('A expired Bearer plus real B cookie only revokes A; no B destroy, Set-Cookie or IdP redirect', async (t) => {
  const f = await fixture(t);
  const before = await f.read(f.B.id);
  const result = await f.request('/api/auth/logout', {
    method: 'POST',
    cookie: f.B.cookie,
    token: f.signed('A'),
  });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.code, 'CENTRAL_LOGOUT_BROWSER_MISMATCH');
  assert.equal(body.redirect, undefined);
  assert.deepEqual(result.headers.getSetCookie(), []);
  assert.deepEqual([...f.revoked], [f.a.reference]);
  assert.deepEqual(f.deleted, [f.ids.A]);
  assert.equal(f.locals.has(f.ids.B), true);
  assert.deepEqual(await f.read(f.B.id), before);
});

test('matching expired access/binding/refresh recovers after Mongo TTL deletion without extending central expiry', async (t) => {
  const f = await fixture(t);
  const stored = await f.read(f.A.id);
  f.a.expiresAtUtc = new Date(0).toISOString();
  stored.centralLogout.central.expiresAtUtc = f.a.expiresAtUtc;
  await f.write(f.A.id, stored);
  f.locals.delete(f.ids.A);
  const cookie = `${f.A.cookie}; refreshToken=${f.signed('A', env.JWT_REFRESH_SECRET)}`;
  const result = await f.request('/api/auth/logout', {
    method: 'POST',
    cookie,
    token: f.signed('A'),
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).redirect, root);
  assert.deepEqual(result.headers.getSetCookie(), []);
  const state = await f.form(cookie);
  const location = await f.start(cookie, state);
  assert.equal(location.searchParams.get('id_token_hint'), 'original-id-token-A');
  assert.equal(
    (await f.read(f.A.id)).centralLogout.central.expiresAtUtc,
    new Date(0).toISOString(),
  );
  const done = await f.request(root + '/callback?state=' + location.searchParams.get('state'), {
    cookie,
  });
  assert.equal(done.status, 200);
  assert.deepEqual(done.headers.getSetCookie(), []);
  assert.equal(await f.read(f.A.id), undefined);
  assert.ok(await f.read(f.B.id));
  const replay = await f.request(root + '/callback?state=' + location.searchParams.get('state'), {
    cookie,
  });
  assert.ok([401, 503].includes(replay.status));
  assert.deepEqual(replay.headers.getSetCookie(), []);
});

test('manual recovery needs no Bearer or live reference; Web outage and IdP error/interruption preserve retry', async (t) => {
  const f = await fixture(t);
  const state = await f.form(f.A.cookie);
  f.setUnavailable(true);
  const failed = await f.request(root + '/continue', {
    method: 'POST',
    cookie: f.A.cookie,
    body: { state },
  });
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.headers.getSetCookie(), []);
  assert.equal(f.deleted.length, 0);
  assert.equal((await f.read(f.A.id)).centralLogout.idToken, 'original-id-token-A');
  f.setUnavailable(false);
  const first = await f.start(f.A.cookie, state);
  const second = await f.start(f.A.cookie, await f.form(f.A.cookie));
  assert.equal(first.searchParams.get('state'), second.searchParams.get('state'));
  const error = await f.request(
    root + '/callback?error=access_denied&state=' + first.searchParams.get('state'),
    { cookie: f.A.cookie },
  );
  assert.equal(error.status, 502);
  assert.deepEqual(error.headers.getSetCookie(), []);
  assert.ok((await error.text()).includes('未完成'));
  assert.ok(await f.read(f.A.id));
  const retry = await f.start(f.A.cookie, state);
  assert.equal(retry.searchParams.get('id_token_hint'), 'original-id-token-A');
});

test('A cookie with B signed refresh is a mismatch even for same owner; never redirect or clear B', async (t) => {
  const f = await fixture(t);
  const cookie = `${f.A.cookie}; refreshToken=${f.signed('B', env.JWT_REFRESH_SECRET)}`;
  const response = await f.request('/api/auth/logout', {
    method: 'POST',
    cookie,
    token: f.signed('A'),
  });
  assert.equal((await response.json()).code, 'CENTRAL_LOGOUT_BROWSER_MISMATCH');
  assert.deepEqual(response.headers.getSetCookie(), []);
  assert.equal((await f.request(root, { cookie })).status, 401);
  assert.ok(await f.read(f.B.id));
});

test('continuation state is browser bound; forged state, cross-origin, retention expiry and wrong routes deny', async (t) => {
  const f = await fixture(t);
  const state = await f.form(f.A.cookie);
  for (const options of [
    { cookie: f.B.cookie, body: { state } },
    { cookie: f.A.cookie, body: { state: 'f'.repeat(64) } },
    { cookie: f.A.cookie, body: { state }, origin: 'https://evil.invalid' },
  ]) {
    const response = await f.request(root + '/continue', { method: 'POST', ...options });
    assert.ok([401, 403].includes(response.status));
    assert.equal(response.headers.get('location'), null);
    assert.deepEqual(response.headers.getSetCookie(), []);
  }
  const expired = await f.read(f.A.id);
  expired.centralLogout.retainUntil = 1;
  await f.write(f.A.id, expired);
  assert.equal((await f.request(root, { cookie: f.A.cookie })).status, 401);
  assert.equal((await f.request(root + '/', { cookie: f.B.cookie })).status, 404);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.deleted, []);
});

test('A callback/continuation after browser signs in B cannot destroy B or return an IdP redirect', async (t) => {
  const f = await fixture(t);
  const state = await f.form(f.A.cookie);
  const location = await f.start(f.A.cookie, state);
  const newB = await f.seed('B', f.A.cookie);
  assert.notEqual(newB.id, f.A.id);
  assert.equal(await f.read(f.A.id), undefined);
  const before = await f.read(newB.id);
  const response = await f.request(root + '/callback?state=' + location.searchParams.get('state'), {
    cookie: newB.cookie,
  });
  assert.equal(response.status, 401);
  assert.deepEqual(response.headers.getSetCookie(), []);
  const continuation = await f.request(root + '/continue', {
    method: 'POST',
    cookie: newB.cookie,
    body: { state },
  });
  assert.equal(continuation.status, 401);
  assert.equal(continuation.headers.get('location'), null);
  assert.deepEqual(continuation.headers.getSetCookie(), []);
  assert.deepEqual(await f.read(newB.id), before);
});

test('callback requires issued, unexpired state; two concurrent returns clear only original once', async (t) => {
  const f = await fixture(t);
  const form = await f.form(f.A.cookie);
  assert.equal(
    (await f.request(root + '/callback?state=' + form, { cookie: f.A.cookie })).status,
    401,
  );
  const url = await f.start(f.A.cookie, form);
  const oldState = url.searchParams.get('state');
  const stored = await f.read(f.A.id);
  stored.centralLogout.pending.expiresAt = 1;
  await f.write(f.A.id, stored);
  assert.equal(
    (await f.request(root + '/callback?state=' + oldState, { cookie: f.A.cookie })).status,
    401,
  );
  const fresh = await f.start(f.A.cookie, form);
  assert.notEqual(fresh.searchParams.get('state'), oldState);
  const responses = await Promise.all(
    [1, 2].map(() =>
      f.request(root + '/callback?state=' + fresh.searchParams.get('state'), {
        cookie: f.A.cookie,
      }),
    ),
  );
  assert.equal(responses.filter((r) => r.status === 200).length, 1);
  assert.equal(responses.filter((r) => [401, 503].includes(r.status)).length, 1);
  responses.forEach((r) => assert.deepEqual(r.headers.getSetCookie(), []));
  assert.ok(await f.read(f.B.id));
});

test('missing original hint refuses generic IdP logout; callback failure gives explicit manual recovery', async (t) => {
  const f = await fixture(t);
  const stored = await f.read(f.A.id);
  delete stored.centralLogout.idToken;
  await f.write(f.A.id, stored);
  const response = await f.request(root, { cookie: f.A.cookie });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('location'), null);
  assert.deepEqual(f.calls, []);
  const rendered = {};
  const res = {
    set() {
      return this;
    },
    status(value) {
      rendered.status = value;
      return this;
    },
    type() {
      return this;
    },
    send(value) {
      rendered.html = value;
      return this;
    },
  };
  createCentralSSO({ env }).centralLoginFailure({}, res);
  assert.equal(rendered.status, 401);
  assert.ok(rendered.html.includes('中央登入失敗'));
  assert.ok(rendered.html.includes(root));
  assert.ok(!rendered.html.includes('original-id-token'));
});

test('actual OAuth callback rejects expired-register failure and preserves original logout recovery', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/oauth/openid/callback?code=synthetic&state=synthetic', {
    cookie: f.A.cookie,
  });
  assert.equal(response.status, 401);
  const html = await response.text();
  assert.ok(html.includes('中央登入失敗'));
  assert.ok(html.includes(root));
  assert.ok(!html.includes('synthetic expired registration'));
  assert.ok(!html.includes('original-id-token'));
  assert.equal((await f.read(f.A.id)).centralLogout.idToken, 'original-id-token-A');
  await f.start(f.A.cookie, await f.form(f.A.cookie));
});
