const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCentralSSO } = require('../api/server/services/LocalCentralSSO');
const { validate } = require('../api/server/services/CentralTrustProfile');
const demo = () => ({
  OPENSCHOOL_CENTRAL_SSO: 'true',
  OPENSCHOOL_CENTRAL_PROFILE: 'demo',
  NODE_ENV: 'production',
  OPENID_ISSUER: 'https://openschool.langracetech.com/identity/realms/openschool',
  OPENID_CLIENT_ID: 'chat-demo',
  OPENSCHOOL_CENTRAL_API_URL: 'http://school:8080',
  OPENSCHOOL_CENTRAL_API_KEY: 'a'.repeat(48),
  OPENID_CLIENT_SECRET: 'b'.repeat(48),
  DOMAIN_CLIENT: 'https://openschool.langracetech.com/chat',
  DOMAIN_SERVER: 'https://openschool.langracetech.com/chat',
  OPENID_CALLBACK_URL: '/oauth/openid/callback',
  OPENID_USE_PKCE: 'true',
  USE_REDIS: 'true',
  REDIS_URI: `redis://:${'c'.repeat(64)}@chat-session:6379/0`,
});
test('designated demo validates fixed transport and central bindings', () => {
  const env = demo();
  const service = createCentralSSO({ env });
  service.assertConfig();
  assert.equal(validate(env).prefix, '/chat');
  const binding = {
    reference: '11111111-1111-7111-8111-111111111111',
    issuer: env.OPENID_ISSUER,
    clientId: 'chat-demo',
    subject: 'synthetic',
    sid: 'synthetic-sid',
    memberId: '11111111-1111-7111-8111-111111111112',
    chatOwnerId: '1'.repeat(24),
    expiresAtUtc: new Date(Date.now() + 300000).toISOString(),
  };
  assert.equal(service.binding(binding).issuer, env.OPENID_ISSUER);
  assert.throws(() => service.binding({ ...binding, clientId: 'chat-local' }));
  assert.throws(() =>
    service.binding({ ...binding, issuer: 'http://localhost:15480/realms/langrace-local' }),
  );
});
test('demo rejects alternate authority, environment, callback, API or volatile store', () => {
  for (const [key, value] of Object.entries({
    NODE_ENV: 'development',
    OPENID_ISSUER: 'https://evil.example',
    OPENID_CLIENT_ID: 'chat-local',
    OPENSCHOOL_CENTRAL_API_URL: 'http://attacker',
    DOMAIN_CLIENT: 'https://evil.example/chat',
    DOMAIN_SERVER: 'https://openschool.langracetech.com',
    OPENID_CALLBACK_URL: 'https://evil.example/callback',
    OPENID_USE_PKCE: 'false',
    USE_REDIS: 'false',
    REDIS_URI: 'redis://localhost:6379',
    OPENID_REUSE_TOKENS: 'true',
    OPENSCHOOL_CENTRAL_PROFILE: 'arbitrary',
    OPENSCHOOL_CENTRAL_API_KEY: 'short',
    OPENID_CLIENT_SECRET: '',
  })) {
    assert.throws(() => createCentralSSO({ env: { ...demo(), [key]: value } }).assertConfig(), key);
  }
});
test('demo recovery UI uses prefixed links and exact CSP without local origin', async () => {
  const env = demo();
  const service = createCentralSSO({ env });
  const captured = {};
  const res = {
    set(value) {
      captured.headers = value;
      return this;
    },
    status(value) {
      captured.status = value;
      return this;
    },
    type() {
      return this;
    },
    send(value) {
      captured.body = value;
      return this;
    },
    sendStatus(value) {
      captured.status = value;
    },
  };
  // Missing record is a controlled failure page, not a new authenticated session.
  await service.logoutRecovery({
    verifyToken() {
      throw Error('No token');
    },
  })({ method: 'GET', path: '/central-logout', sessionID: 'synthetic', session: null }, res);
  assert.ok(
    captured.headers['Content-Security-Policy'].includes(
      env.OPENID_ISSUER + '/protocol/openid-connect/logout',
    ),
  );
  assert.ok(captured.body.includes('/chat/login?redirect=false'));
  assert.ok(!captured.body.includes('localhost'));
});
for (const value of [undefined, '', 'false', '0', '1', 'yes', 'TRUE', ' true ']) {
  test(`demo rejects non-explicit SSO flag ${JSON.stringify(value)}`, () => {
    const env = { ...demo(), OPENSCHOOL_CENTRAL_SSO: value };
    assert.throws(() => validate(env));
    assert.throws(() => createCentralSSO({ env }));
  });
}
test('demo guards reject disabled flag after initialization across all auth routers', () => {
  const env = demo();
  const service = createCentralSSO({ env });
  env.OPENSCHOOL_CENTRAL_SSO = 'false';
  for (const kind of ['auth', 'oauth', 'admin']) {
    let status;
    let continued = false;
    const res = {
      status(value) {
        status = value;
        return this;
      },
      json() {},
    };
    service.guardRoutes(kind)({ path: '/login' }, res, () => {
      continued = true;
    });
    assert.equal(status, 503);
    assert.equal(continued, false);
  }
});
test('legacy profile without central SSO retains existing routing', () => {
  const service = createCentralSSO({ env: {} });
  let continued = false;
  service.guardRoutes('auth')({ path: '/login' }, {}, () => {
    continued = true;
  });
  assert.equal(continued, true);
});
