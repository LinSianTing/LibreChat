const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const ts = require('typescript');
const dataProvider = require('librechat-data-provider');
const { createCentralSSO } = require('../api/server/services/LocalCentralSSO');
const env = {
  OPENSCHOOL_CENTRAL_SSO: 'true',
  NODE_ENV: 'development',
  OPENID_CLIENT_ID: 'chat-local',
  OPENID_ISSUER: 'http://localhost:15480/realms/langrace-local',
  OPENSCHOOL_CENTRAL_API_URL: 'http://localhost:15481',
  OPENSCHOOL_CENTRAL_API_KEY: 'test-secret',
  JWT_REFRESH_SECRET: 'test-refresh-secret',
  OPENID_SESSION_SECRET: 'test-session',
  ALLOW_EMAIL_LOGIN: 'true',
  ALLOW_REGISTRATION: 'true',
  ALLOW_PASSWORD_RESET: 'true',
  GOOGLE_CLIENT_ID: 'blocked',
  GOOGLE_CLIENT_SECRET: 'blocked',
};
const central = {
  reference: '01900000-0000-7000-8000-000000000001',
  issuer: env.OPENID_ISSUER,
  clientId: 'chat-local',
  subject: 'subject',
  sid: 'sid',
  memberId: '01900000-0000-7000-8000-000000000002',
  chatOwnerId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  expiresAtUtc: new Date(Date.now() + 3600000).toISOString(),
};
const sessionId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const pass = (_req, _res, next) => next();
const logger = { error() {}, warn() {}, info() {}, debug() {} };
const schemas = { logger, runAsSystem: (fn) => fn(), tenantStorage: { run: (_ctx, fn) => fn() } };
function load(relative, supplied, typed = false) {
  const filename = path.join(__dirname, '..', relative);
  const module = { exports: {} };
  let source = fs.readFileSync(filename, 'utf8');
  if (typed)
    source = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  vm.runInNewContext(
    source,
    {
      module,
      exports: module.exports,
      process: { env },
      URL,
      Buffer,
      require: (name) => supplied[name] ?? {},
    },
    { filename },
  );
  return module.exports;
}
async function fixture(t) {
  let status = 200;
  let live = { ...central };
  const validations = [];
  const service = createCentralSSO({
    env,
    fetchImpl: async (url, options) => {
      validations.push({ url, body: JSON.parse(options.body) });
      return { status, json: async () => live };
    },
  });
  const models = {
    findSession: async ({ userId, sessionId: requestedSession }) =>
      userId === central.chatOwnerId && requestedSession === sessionId
        ? { _id: sessionId, user: central.chatOwnerId, centralSession: central }
        : null,
    getUserById: async () => ({ _id: central.chatOwnerId, role: 'USER' }),
  };
  const imageApi = load(
    'packages/api/src/images/authorization.ts',
    {
      'node:crypto': require('node:crypto'),
      jsonwebtoken: jwt,
      'librechat-data-provider': dataProvider,
      '@librechat/data-schemas': schemas,
    },
    true,
  );
  const imageAdapter = load('api/server/middleware/validateImageRequest.js', {
    cookie,
    jsonwebtoken: jwt,
    '~/server/services/LocalCentralSSO': service,
    '~/models': models,
    '@librechat/api': { ...imageApi, getBasePath: () => '', isEnabled: () => true },
  });
  const optionalJwt = load('api/server/middleware/optionalJwtAuth.js', {
    cookie,
    '~/server/services/LocalCentralSSO': service,
    '@librechat/api': { isEnabled: () => true },
    passport: {
      authenticate: (_name, _options, done) => (_req, _res, next) => {
        done(null, false);
      },
      _strategy: () => ({}),
    },
  });
  const shareAuth = load('api/server/middleware/optionalShareFileAuth.js', {
    cookie,
    jsonwebtoken: jwt,
    '~/models': models,
    '~/server/services/LocalCentralSSO': service,
    '@librechat/api': {},
    '@librechat/data-schemas': schemas,
    'librechat-data-provider': dataProvider,
  });
  const shareApi = new Proxy(
    {
      isEnabled: () => true,
      generateCheckAccess: () => pass,
      createSharedLinkConfigMiddleware: () => pass,
      createSharedLangfuseSessionResolver: () => () => {},
    },
    { get: (target, name) => target[name] ?? (() => {}) },
  );
  const share = load('api/server/routes/share.js', {
    express,
    '@librechat/api': shareApi,
    '@librechat/data-schemas': schemas,
    'librechat-data-provider': dataProvider,
    '~/models': models,
    '~/server/middleware/optionalJwtAuth': optionalJwt,
    '~/server/middleware/optionalShareFileAuth': shareAuth,
    '~/server/middleware/requireJwtAuth': (_req, res) => res.sendStatus(401),
    '~/server/middleware/config/app': pass,
    '~/server/middleware/canAccessSharedLink': (req, res) =>
      res.json({ memberId: req.user?.memberId, reference: req.user?.centralSessionReference }),
    '~/server/middleware/limiters': {
      createForkLimiters: () => ({ forkIpLimiter: pass, forkUserLimiter: pass }),
      createShareLimiters: () => ({ shareIpLimiter: pass, shareUserLimiter: pass }),
    },
  });
  const config = load('api/server/routes/config.js', {
    express,
    '~/server/services/LocalCentralSSO': service,
    '@librechat/api': new Proxy(
      { isEnabled: (value) => value === 'true', resolveBuildInfo: () => ({}) },
      { get: (target, name) => target[name] ?? (() => {}) },
    ),
    '@librechat/data-schemas': { ...schemas, getTenantId: () => undefined },
    'librechat-data-provider': dataProvider,
    '~/server/services/Config/ldap': { getLdapConfig: () => ({ enabled: true }) },
    '~/server/services/Config/rum': { getRumConfig: () => null },
    '~/server/services/Config/app': {
      getAppConfig: async () => ({ registration: { socialLogins: ['google'] } }),
    },
  });
  const app = express();
  app.use('/images', imageAdapter(false), (_req, res) => res.send('image-allowed'));
  app.use('/api/share', share);
  app.use('/api/config', config);
  const server = await new Promise((resolve) => {
    const handle = app.listen(0, '127.0.0.1', () => resolve(handle));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const token = (patch = {}) =>
    jwt.sign(
      { id: central.chatOwnerId, sessionId, centralSession: central, ...patch },
      env.JWT_REFRESH_SECRET,
      { expiresIn: 600 },
    );
  const get = (route, refresh = token(), extraHeaders = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      headers: { Cookie: `refreshToken=${refresh}; token_provider=openid`, ...extraHeaders },
    });
  return {
    get,
    token,
    validations,
    setStatus: (value) => {
      status = value;
    },
    setLive: (value) => {
      live = value;
    },
  };
}

test('actual image route requires central live validation even with secureImageLinks=false', async (t) => {
  const f = await fixture(t);
  const route = `/images/${central.chatOwnerId}/file.png`;
  assert.equal((await f.get(route)).status, 200);
  for (const status of [401, 503]) {
    f.setStatus(status);
    assert.equal((await f.get(route)).status, 403);
  }
  f.setStatus(200);
  assert.equal((await f.get(route, f.token({ centralSession: undefined }))).status, 403);
  f.setLive({ ...central, memberId: '01900000-0000-7000-8000-000000000009' });
  assert.equal((await f.get(route)).status, 403);
  assert.ok(f.validations.every((call) => call.url.endsWith('/validate')));
});

test('all actual share file routes validate cookie binding and never restore a denied Bearer from cookies', async (t) => {
  const f = await fixture(t);
  for (const suffix of ['', '/preview', '/download']) {
    const route = `/api/share/shared/files/file${suffix}`;
    f.setStatus(200);
    const allowed = await f.get(route);
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).memberId, central.memberId);
    const count = f.validations.length;
    assert.equal(
      (await f.get(route, f.token(), { Authorization: 'Bearer denied-access-token' })).status,
      401,
    );
    assert.equal(f.validations.length, count);
    f.setStatus(401);
    assert.equal((await f.get(route)).status, 401);
    f.setStatus(503);
    assert.equal((await f.get(route)).status, 503);
  }
});

test('public-client startup config shows forced-PKCE OIDC and hides blocked providers without exposing secrets', async (t) => {
  const f = await fixture(t);
  const response = await f.get('/api/config');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.openidLoginEnabled, true);
  assert.equal(data.centralLogoutEnabled, true);
  assert.equal(data.openidAutoRedirect, false);
  assert.equal(data.socialLoginEnabled, true);
  assert.deepEqual(data.socialLogins, ['openid']);
  for (const name of [
    'emailLoginEnabled',
    'passwordResetEnabled',
    'registrationEnabled',
    'googleLoginEnabled',
    'samlLoginEnabled',
  ])
    assert.equal(data[name], false);
  assert.equal(data.ldap, undefined);
  assert.equal(JSON.stringify(data).includes(env.OPENSCHOOL_CENTRAL_API_KEY), false);
});
