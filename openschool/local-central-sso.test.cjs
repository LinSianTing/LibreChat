const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createCentralSSO } = require('../api/server/services/LocalCentralSSO');

const env = {
  OPENSCHOOL_CENTRAL_SSO: 'true',
  NODE_ENV: 'development',
  OPENID_ISSUER: 'http://localhost:15480/realms/langrace-local',
  OPENID_CLIENT_ID: 'chat-local',
  OPENSCHOOL_CENTRAL_API_URL: 'http://localhost:15481',
  OPENSCHOOL_CENTRAL_API_KEY: 'test-only',
  JWT_SECRET: 'test-only',
  JWT_REFRESH_SECRET: 'refresh-test-only',
};
const central = () => ({
  reference: '01900000-0000-7000-8000-000000000001',
  issuer: env.OPENID_ISSUER,
  clientId: 'chat-local',
  subject: 'keycloak-subject',
  sid: 'keycloak-session',
  memberId: '01900000-0000-7000-8000-000000000002',
  chatOwnerId: '1234567890abcdef12345678',
  expiresAtUtc: new Date(Date.now() + 3600000).toISOString(),
});
const user = (binding) => ({
  _id: binding.chatOwnerId,
  role: 'USER',
  provider: 'local',
  email: 'unchanged@test.invalid',
});
const tokens = (binding) => ({
  id_token: 'opaque-library-verified-id-token',
  claims: () => ({
    iss: binding.issuer,
    sub: binding.subject,
    sid: binding.sid,
    aud: binding.clientId,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
});
function fixture(overrides = {}) {
  const value = central();
  const calls = [];
  const service = createCentralSSO({
    env: { ...env },
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      return {
        status: url.endsWith('/revoke') ? 204 : 200,
        json: async () => ({ ...value }),
      };
    },
    ...overrides,
  });
  return { value, calls, service };
}
const rejects = (fn) => assert.rejects(fn, /Central session is not authorized/);
const logoutRequest = () => ({
  method: 'POST',
  baseUrl: '/api/auth',
  path: '/logout',
  headers: { authorization: 'Bearer stub.payload.signature' },
});
/** Dependency-free wiring substitute only; real signature tests live in local-central-logout.test.cjs. */
const logoutVerifier = (value) => (_token, secret, options) => {
  assert.equal(secret, env.JWT_SECRET);
  assert.deepEqual(options, { algorithms: ['HS256'], ignoreExpiration: true });
  return {
    id: value.chatOwnerId,
    sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    centralSession: value,
    exp: 1,
  };
};
const response = () => ({
  cookies: [],
  cleared: [],
  code: 200,
  cookie(name, value) {
    this.cookies.push({ name, value });
    return this;
  },
  clearCookie(name) {
    this.cleared.push(name);
    return this;
  },
  status(code) {
    this.code = code;
    return this;
  },
  send(body) {
    this.body = body;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

test('register contract uses only verified id_token and exact preexisting ordinary owner; no legacy Google dependency', async () => {
  const { value, calls, service } = fixture();
  const original = user(value);
  const authenticated = await service.registerVerified(tokens(value), async (query) => {
    assert.deepEqual(query, { _id: value.chatOwnerId });
    return original;
  });
  assert.equal(authenticated.memberId, value.memberId);
  assert.equal(authenticated.reference, value.reference);
  assert.equal(authenticated.centralSessionReference, value.reference);
  assert.equal(original.memberId, undefined);
  assert.equal(original.provider, 'local');
  assert.deepEqual(JSON.parse(calls[0].body), { idToken: 'opaque-library-verified-id-token' });
  assert.equal(calls[0].headers['X-OpenSchool-Central-Key'], 'test-only');
  assert.equal(calls[0].redirect, 'error');
  const req = { user: authenticated };
  const prepared = await service.prepareTokens(value.chatOwnerId, null, req, async () => original);
  assert.equal(prepared.user.memberId, value.memberId);
  assert.equal(calls[1].url, `${env.OPENSCHOOL_CENTRAL_API_URL}/internal/central-sso/validate`);
  await rejects(() =>
    service.prepareTokens(value.chatOwnerId, null, { user: authenticated }, async () => original),
  );
  await rejects(() =>
    service.prepareTokens(
      value.chatOwnerId,
      null,
      { user: { ...authenticated } },
      async () => original,
    ),
  );
});

for (const patch of [
  { NODE_ENV: 'production' },
  { OPENID_ISSUER: 'https://other.invalid' },
  { OPENID_CLIENT_ID: 'web-local' },
  { OPENSCHOOL_CENTRAL_API_URL: 'http://other:15481' },
  { OPENSCHOOL_CENTRAL_API_KEY: '' },
  { OPENID_REUSE_TOKENS: ' true ' },
  { OPENID_REUSE_TOKENS: '1' },
]) {
  test(`invalid enabled configuration fails closed: ${Object.keys(patch)[0]}=${Object.values(patch)[0]}`, () => {
    assert.throws(() => createCentralSSO({ env: { ...env, ...patch } }).assertConfig());
  });
}
for (const patch of [
  { reference: undefined },
  { memberId: '00000000-0000-0000-0000-000000000000' },
  { chatOwnerId: 'not-an-owner' },
  { issuer: 'https://other.invalid' },
  { clientId: 'web-local' },
  { sid: '' },
  { subject: '' },
  { expiresAtUtc: new Date(0).toISOString() },
]) {
  test(`malformed central response denies: ${Object.keys(patch)[0]}`, async () => {
    const { service, value } = fixture({
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({ ...central(), ...patch }),
      }),
    });
    await rejects(() => service.registerVerified(tokens(value), async () => user(value)));
  });
}
test('callback rejects decoded-only claims, admin entry, wrong audience, absent sid and subject mismatch', async () => {
  const { service, value, calls } = fixture();
  await rejects(() =>
    service.registerVerified({ ...tokens(value).claims(), id_token: 'untrusted' }, async () =>
      user(value),
    ),
  );
  await rejects(() => service.registerVerified(tokens(value), async () => user(value), true));
  await rejects(() =>
    service.registerVerified(tokens({ ...value, clientId: 'web-local' }), async () => user(value)),
  );
  await rejects(() =>
    service.registerVerified(tokens({ ...value, sid: '' }), async () => user(value)),
  );
  assert.equal(calls.length, 0);
  await rejects(() =>
    service.registerVerified(tokens({ ...value, subject: 'another-subject' }), async () =>
      user(value),
    ),
  );
});
test('missing, admin, temporary, deleting and wrong Mongo owners deny without user mutation', async () => {
  const { service, value } = fixture();
  for (const candidate of [
    null,
    { ...user(value), role: 'ADMIN' },
    { ...user(value), role: undefined },
    { ...user(value), _id: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
    { ...user(value), expiresAt: new Date() },
    { ...user(value), tenantId: 'other' },
    { ...user(value), agentTriggerDeletionStartedAt: new Date() },
  ]) {
    await rejects(() => service.registerVerified(tokens(value), async () => candidate));
  }
});
test('every JWT validates reference and compares signed, stored, live identity; missing local session denies', async () => {
  const { service, value, calls } = fixture();
  const payload = {
    id: value.chatOwnerId,
    sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    centralSession: value,
  };
  const session = { user: value.chatOwnerId, centralSession: value };
  for (let i = 0; i < 2; i++) {
    const authenticated = await service.authorize(payload, user(value), async () => session);
    assert.equal(authenticated.memberId, value.memberId);
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].body), { reference: value.reference });
  await rejects(() =>
    service.authorize({ ...payload, centralSession: undefined }, user(value), async () => session),
  );
  await rejects(() => service.authorize(payload, user(value), async () => null));
  for (const field of ['reference', 'memberId', 'chatOwnerId', 'sid', 'subject']) {
    const changed = {
      ...value,
      [field]:
        field === 'chatOwnerId'
          ? 'bbbbbbbbbbbbbbbbbbbbbbbb'
          : field === 'reference' || field === 'memberId'
            ? '01900000-0000-7000-8000-000000000099'
            : 'changed',
    };
    await rejects(() =>
      service.authorize({ ...payload, centralSession: changed }, user(value), async () => session),
    );
    await rejects(() => service.validate(changed));
  }
});
test('refresh validates original reference without registering or extending expiry', async () => {
  const { service, value, calls } = fixture();
  const session = { user: value.chatOwnerId, centralSession: value };
  const req = {};
  const prepared = await service.prepareTokens(value.chatOwnerId, session, req, async () =>
    user(value),
  );
  assert.equal(prepared.central.reference, value.reference);
  assert.equal(req.user.memberId, value.memberId);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/validate'));
  await rejects(() =>
    service.prepareTokens(
      value.chatOwnerId,
      { ...session, centralSession: undefined },
      {},
      async () => user(value),
    ),
  );
});
for (const status of [401, 503, 302, 500]) {
  test(`central HTTP ${status} denies with no retry`, async () => {
    let count = 0;
    const service = createCentralSSO({
      env,
      fetchImpl: async () => {
        count++;
        return { status };
      },
    });
    await rejects(() => service.validate(central()));
    assert.equal(count, 1);
  });
}
test('network and malformed JSON fail closed', async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error('private transport detail');
    },
    async () => ({
      status: 200,
      json: async () => {
        throw new Error('secret body');
      },
    }),
  ]) {
    await rejects(() => createCentralSSO({ env, fetchImpl }).validate(central()));
  }
});
test('2.5-second deadline includes stalled body parsing and aborts without retry', async () => {
  let signal;
  let count = 0;
  const service = createCentralSSO({
    env,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      count++;
      return { status: 200, json: () => new Promise(() => {}) };
    },
  });
  const start = Date.now();
  await rejects(() => service.validate(central()));
  assert.ok(Date.now() - start >= 2400 && Date.now() - start < 3500);
  assert.equal(signal.aborted, true);
  assert.equal(count, 1);
});
test('logout revokes first, deletes only signed local session, destroys browser state, returns exact Keycloak redirect', async () => {
  const order = [];
  const { service, value } = fixture({
    fetchImpl: async (url, options) => {
      assert.ok(url.endsWith('/revoke'));
      assert.deepEqual(JSON.parse(options.body), { reference: central().reference });
      order.push('revoke');
      return { status: 204 };
    },
  });
  const sessions = new Set(['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb']);
  const req = {
    ...logoutRequest(),
    session: {
      destroy(cb) {
        order.push('destroy');
        cb();
      },
    },
  };
  const res = response();
  await service.logout(req, res, {
    verifyToken: logoutVerifier(value),
    deleteSession: async ({ sessionId }) => {
      order.push('delete');
      sessions.delete(sessionId);
    },
    clearCloudFrontCookies: () => {},
  });
  assert.deepEqual(order, ['revoke', 'delete', 'destroy']);
  assert.deepEqual([...sessions], ['bbbbbbbbbbbbbbbbbbbbbbbb']);
  const redirect = new URL(res.body.redirect);
  assert.equal(redirect.origin, 'http://localhost:15480');
  assert.equal(redirect.pathname, '/realms/langrace-local/protocol/openid-connect/logout');
  assert.deepEqual(
    [...redirect.searchParams],
    [
      ['client_id', 'chat-local'],
      ['post_logout_redirect_uri', 'http://localhost:15483/'],
    ],
  );
  assert.ok(res.cleared.includes('refreshToken'));
});
test('failed revoke does not falsely clear local state or redirect', async () => {
  const { service, value } = fixture({ fetchImpl: async () => ({ status: 503 }) });
  const res = response();
  await rejects(() =>
    service.logout(logoutRequest(), res, {
      verifyToken: logoutVerifier(value),
      deleteSession: () => assert.fail('must not delete before revoke'),
      clearCloudFrontCookies: () => assert.fail('must not clear before revoke'),
    }),
  );
  assert.equal(res.body, undefined);
  assert.deepEqual(res.cleared, []);
});
test('enabled route guards close alternate login/registration/admin before side effects; off preserves next()', () => {
  const { service } = fixture();
  for (const [kind, route] of [
    ['auth', '/login'],
    ['auth', '/REGISTER/'],
    ['auth', '/2fa/verify-temp'],
    ['oauth', '/google/callback'],
    ['oauth', '/saml/callback'],
    ['admin', '/refresh'],
  ]) {
    const res = response();
    service.guardRoutes(kind)({ path: route }, res, () => assert.fail('bypass'));
    assert.equal(res.code, 403);
    let next = false;
    createCentralSSO({ env: {} }).guardRoutes(kind)({ path: route }, res, () => {
      next = true;
    });
    assert.equal(next, true);
  }
});

/** Load real CJS hook bodies with explicit substitutes for unavailable workspace dependencies. */
function load(relative, dependencies, extra = '') {
  const filename = path.join(__dirname, '..', relative);
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(filename, 'utf8') + extra,
    {
      module,
      exports: module.exports,
      process: { env: { ...env } },
      URL,
      URLSearchParams,
      Buffer,
      setTimeout,
      clearTimeout,
      console,
      require(name) {
        if (Object.hasOwn(dependencies, name)) return dependencies[name];
        if (name.startsWith('node:')) return require(name);
        return {};
      },
    },
    { filename },
  );
  return module.exports;
}
const logger = { error() {}, warn() {}, info() {}, debug() {} };
const api = {
  math: (_value, fallback) => fallback,
  isEnabled: (value) => value === 'true',
  shouldUseSecureCookie: () => false,
  getCloudFrontConfig: () => ({ enabled: false }),
};
const schemas = {
  logger,
  DEFAULT_SESSION_EXPIRY: 900000,
  DEFAULT_REFRESH_TOKEN_EXPIRY: 604800000,
  runAsSystem: (fn) => fn(),
};

test('real Passport callback hook registers before legacy user logic and refuses admin callback', async () => {
  const { service, value, calls } = fixture();
  const strategies = {};
  class Strategy {
    constructor(options, callback) {
      this.options = options;
      this.callback = callback;
    }
    authorizationRequestParams() {
      return new URLSearchParams();
    }
  }
  const module = load(
    'api/strategies/openidStrategy.js',
    {
      '~/server/services/LocalCentralSSO': service,
      '~/models': {
        findUser: async () => user(value),
        createUser: () => assert.fail('no registration'),
      },
      '@librechat/api': api,
      '@librechat/data-schemas': schemas,
      'librechat-data-provider': { ErrorTypes: { AUTH_FAILED: 'AUTH_FAILED' } },
      'openid-client/passport': { Strategy },
      passport: {
        use: (name, strategy) => {
          strategies[name] = strategy;
        },
      },
      'openid-client': {
        discovery: async () => ({}),
        randomState: () => 'state',
        randomNonce: () => 'nonce',
        allowInsecureRequests() {},
      },
    },
    '\nmodule.exports.adminCallback = createOpenIDCallback(true);',
  );
  await module.setupOpenId();
  assert.ok(strategies.openid);
  assert.equal(strategies.openidAdmin, undefined);
  assert.equal(strategies.openid.authorizationRequestParams({}, {}).get('nonce'), 'nonce');
  assert.equal(strategies.openid.authorizationRequestParams({}, {}).get('state'), 'state');
  let authenticated;
  await strategies.openid.callback(tokens(value), (error, result) => {
    assert.ifError(error);
    authenticated = result;
  });
  assert.equal(authenticated.reference, value.reference);
  await module.adminCallback(tokens(value), (error) => assert.ok(error));
  assert.equal(calls.length, 1);
});

test('real JWT strategy rejects unbound token and publishes validated member/reference without role fallback', async () => {
  const { service, value } = fixture();
  const sessionId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  let verify;
  const factory = load('api/strategies/jwtStrategy.js', {
    '~/server/services/LocalCentralSSO': service,
    '@librechat/api': { AGENT_TRIGGER_SCOPE: 'agent-trigger' },
    '@librechat/data-schemas': schemas,
    'passport-jwt': {
      ExtractJwt: { fromAuthHeaderAsBearerToken: () => {} },
      Strategy: class {
        constructor(_options, callback) {
          verify = callback;
        }
      },
    },
    '~/models': {
      getUserById: async () => user(value),
      findSession: async () => ({ user: value.chatOwnerId, centralSession: value }),
      updateUser: () => assert.fail('no role mutation'),
    },
  });
  factory();
  await verify({}, { id: value.chatOwnerId }, (error, result) => {
    assert.ifError(error);
    assert.equal(result, false);
  });
  const req = {};
  await verify(
    req,
    { id: value.chatOwnerId, sessionId, centralSession: value },
    (error, result) => {
      assert.ifError(error);
      assert.equal(result.memberId, value.memberId);
      assert.equal(result.reference, value.reference);
    },
  );
  assert.equal(req.centralSessionId, sessionId);
});

test('real refresh hook refuses unbound refresh even with retry flag; valid refresh passes same stored session', async () => {
  const { service, value } = fixture();
  const session = {
    _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    user: value.chatOwnerId,
    centralSession: value,
  };
  let payload = { id: value.chatOwnerId, sessionId: session._id };
  let issued = 0;
  const module = load('api/server/controllers/AuthController.js', {
    '~/server/services/LocalCentralSSO': service,
    '@librechat/api': api,
    '@librechat/data-schemas': schemas,
    cookie: { parse: () => ({ refreshToken: 'signed-refresh', token_provider: 'openid' }) },
    jsonwebtoken: { verify: () => payload },
    '~/models': { findSession: async () => session },
    '~/server/services/AuthService': {
      setAuthTokens: async (id, _res, original, req) => {
        issued++;
        assert.equal(original, session);
        await service.prepareTokens(id, original, req, async () => user(value));
        return 'chat-jwt';
      },
    },
  });
  const req = { headers: { cookie: 'test' }, query: { retry: true } };
  const deniedRes = response();
  await module.refreshController(req, deniedRes);
  assert.equal(deniedRes.code, 401);
  assert.equal(issued, 0);
  payload = { ...payload, centralSession: value };
  const accepted = response();
  await module.refreshController(req, accepted);
  assert.equal(accepted.body.token, 'chat-jwt');
  assert.equal(accepted.body.user.memberId, value.memberId);
  assert.equal(issued, 1);
});

test('real setAuthTokens persists callback binding before signing own JWT, survives user reload and refreshes same session', async () => {
  const { service, value, calls } = fixture();
  const originalUser = user(value);
  const callbackUser = await service.registerVerified(tokens(value), async () => originalUser);
  let stored;
  let created = 0;
  let rotated = 0;
  let signed;
  const module = load('api/server/services/AuthService.js', {
    './LocalCentralSSO': service,
    '@librechat/api': api,
    '@librechat/data-schemas': schemas,
    jsonwebtoken: {
      sign: (payload, secret, options) => {
        assert.equal(secret, env.JWT_SECRET);
        assert.equal(options.algorithm, 'HS256');
        assert.ok(options.expiresIn > 0 && options.expiresIn <= 900);
        signed = payload;
        return 'own-chat-jwt';
      },
    },
    '~/models': {
      getUserById: async () => originalUser,
      createSession: async (id, options) => {
        created++;
        stored = {
          _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
          user: id,
          expiration: options.expiration,
          centralSession: options.centralSession,
        };
        return { session: stored, refreshToken: 'own-refresh-token' };
      },
      generateRefreshToken: async (session) => {
        assert.equal(session, stored);
        rotated++;
        return 'rotated-own-refresh-token';
      },
      generateToken: () => assert.fail('must not generate unbound legacy JWT'),
    },
  });
  const req = { user: callbackUser, headers: {} };
  const res = response();
  assert.equal(await module.setAuthTokens(value.chatOwnerId, res, null, req), 'own-chat-jwt');
  assert.equal(stored.centralSession.reference, value.reference);
  assert.ok(stored.expiration.getTime() <= Date.parse(value.expiresAtUtc));
  assert.equal(signed.sessionId, stored._id);
  assert.equal(signed.centralSession.memberId, value.memberId);
  assert.equal(req.user.centralSessionReference, value.reference);
  assert.equal(originalUser.memberId, undefined);
  const expiry = stored.expiration.getTime();
  await module.setAuthTokens(value.chatOwnerId, response(), stored, { headers: {} });
  assert.equal(created, 1);
  assert.equal(rotated, 1);
  assert.equal(stored.expiration.getTime(), expiry);
  assert.equal(calls.filter((call) => call.url.endsWith('/register')).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith('/validate')).length, 2);
  await rejects(() =>
    module.setAuthTokens(value.chatOwnerId, response(), null, { user: originalUser }),
  );
});

test('revoking browser A rejects A JWT/refresh while browser B remains authorized', async () => {
  const a = central();
  const b = { ...a, reference: '01900000-0000-7000-8000-000000000003', sid: 'browser-b' };
  const registry = new Map([
    [a.reference, a],
    [b.reference, b],
  ]);
  const service = createCentralSSO({
    env,
    fetchImpl: async (url, options) => {
      const { reference } = JSON.parse(options.body);
      if (url.endsWith('/revoke')) {
        registry.delete(reference);
        return { status: 204 };
      }
      return {
        status: registry.has(reference) ? 200 : 401,
        json: async () => registry.get(reference),
      };
    },
  });
  const sessions = new Map([
    ['aaaaaaaaaaaaaaaaaaaaaaaa', { user: a.chatOwnerId, centralSession: a }],
    ['bbbbbbbbbbbbbbbbbbbbbbbb', { user: b.chatOwnerId, centralSession: b }],
  ]);
  const payload = (id, binding) => ({
    id: binding.chatOwnerId,
    sessionId: id,
    centralSession: binding,
  });
  const find = async ({ sessionId }) => sessions.get(sessionId);
  await service.authorize(payload('aaaaaaaaaaaaaaaaaaaaaaaa', a), user(a), find);
  await service.logout(logoutRequest(), response(), {
    verifyToken: logoutVerifier(a),
    deleteSession: async ({ sessionId }) => sessions.delete(sessionId),
    clearCloudFrontCookies() {},
  });
  await rejects(() => service.authorize(payload('aaaaaaaaaaaaaaaaaaaaaaaa', a), user(a), find));
  await rejects(() =>
    service.prepareTokens(a.chatOwnerId, { user: a.chatOwnerId, centralSession: a }, {}, async () =>
      user(a),
    ),
  );
  const authenticated = await service.authorize(
    payload('bbbbbbbbbbbbbbbbbbbbbbbb', b),
    user(b),
    find,
  );
  assert.equal(authenticated.centralSessionReference, b.reference);
  await service.prepareTokens(
    b.chatOwnerId,
    sessions.get('bbbbbbbbbbbbbbbbbbbbbbbb'),
    {},
    async () => user(b),
  );
});

test('feature off keeps legacy setAuthTokens behavior without a central lookup or added binding', async () => {
  const disabled = createCentralSSO({
    env: {},
    fetchImpl: () => assert.fail('feature off HTTP call'),
  });
  const ordinary = user(central());
  let created = 0;
  let generated = 0;
  const module = load('api/server/services/AuthService.js', {
    './LocalCentralSSO': disabled,
    '@librechat/api': api,
    '@librechat/data-schemas': schemas,
    '~/models': {
      getUserById: async () => ordinary,
      createSession: async (_id, options) => {
        assert.equal(options.centralSession, undefined);
        created++;
        return {
          session: { expiration: new Date(Date.now() + 100000) },
          refreshToken: 'legacy-refresh',
        };
      },
      generateToken: async (reloaded) => {
        assert.equal(reloaded, ordinary);
        generated++;
        return 'legacy-access';
      },
    },
  });
  const req = { headers: {}, user: ordinary };
  const res = response();
  assert.equal(await module.setAuthTokens(ordinary._id, res, null, req), 'legacy-access');
  assert.equal(created, 1);
  assert.equal(generated, 1);
  assert.equal(req.user.memberId, undefined);
  assert.equal(res.cookies[0].value, 'legacy-refresh');
});

test('optional JWT middleware cannot choose reused OpenID tokens when central mode is enabled', () => {
  const { service } = fixture();
  let selected;
  const middleware = load('api/server/middleware/optionalJwtAuth.js', {
    '~/server/services/LocalCentralSSO': service,
    '@librechat/api': { isEnabled: () => true },
    cookie: { parse: () => ({ token_provider: 'openid' }) },
    passport: {
      _strategy: () => ({}),
      authenticate: (name) => {
        selected = name;
        return () => {};
      },
    },
  });
  middleware({ headers: { cookie: 'untrusted' } }, response(), () => {});
  assert.equal(selected, 'jwt');
});
