const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const profiles = require('../api/server/services/CentralTrustProfile');

function load(relative, deps, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), {
    module,
    require(name) {
      assert.ok(Object.hasOwn(deps, name), `Unexpected dependency ${name}`);
      return deps[name];
    },
    ...globals,
  });
  return module.exports;
}

function fixture(
  overrides = {},
  upstream = () =>
    new Response(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'circle-p0-sso-mock' }],
      }),
    ),
) {
  const env = {
    OPENSCHOOL_CENTRAL_SSO: 'true',
    OPENSCHOOL_CENTRAL_PROFILE: 'demo',
    NODE_ENV: 'production',
    OPENID_CLIENT_ID: 'chat-demo',
    OPENID_ISSUER: profiles.select({ OPENSCHOOL_CENTRAL_PROFILE: 'demo' }).issuer,
    OPENSCHOOL_CENTRAL_API_URL: 'http://school:8080',
    OPENSCHOOL_CENTRAL_API_KEY: 's'.repeat(40),
    OPENSCHOOL_GATEWAY_KEY: 's'.repeat(40),
    DOMAIN_CLIENT: 'https://openschool.langracetech.com/chat',
    DOMAIN_SERVER: 'https://openschool.langracetech.com/chat',
    OPENID_CALLBACK_URL: '/oauth/openid/callback',
    OPENID_USE_PKCE: 'true',
    USE_REDIS: 'true',
    REDIS_URI: `redis://:${'s'.repeat(40)}@chat-session:6379/0`,
    OPENID_CLIENT_SECRET: 's'.repeat(40),
    ...overrides,
  };
  const central = { enabled: () => env.OPENSCHOOL_CENTRAL_SSO === 'true' };
  const calls = [];
  const gateway = load(
    'api/server/services/CentralGateway.js',
    {
      './LocalCentralSSO': central,
      './CentralTrustProfile': profiles,
    },
    {
      process: { env },
      AbortSignal,
      fetch: async (url, options) => {
        calls.push({ url, options });
        return upstream();
      },
    },
  );
  const controller = load('api/server/controllers/ModelController.js', {
    '@librechat/data-schemas': { logger: { error() {} } },
    '~/server/services/Config': {
      loadDefaultModels: () => assert.fail('No default fallback'),
      loadConfigModels: () => assert.fail('No YAML fallback'),
    },
    '~/server/services/LocalCentralSSO': central,
    '~/server/services/CentralGateway': gateway,
  });
  const app = express();
  app.get('/api/models', (req, res) => {
    // Authentication itself is outside this controller wiring test.
    req.user = {
      memberId: '11111111-1111-7111-8111-111111111111',
      centralSessionReference: '22222222-2222-7222-8222-222222222222',
    };
    return controller.modelController(req, res);
  });
  return { app, calls };
}

test('demo model HTTP wiring returns eligible list and private no-store', async () => {
  const { app, calls } = fixture();
  const res = await request(app).get('/api/models');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { OpenSchool: ['circle-p0-sso-mock'] });
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://school:8080/ai-gateway/v1/models');
  assert.equal(calls[0].options.redirect, 'error');
});

test('non-demo production stays 503 without contacting any gateway', async () => {
  const { app, calls } = fixture({ OPENSCHOOL_CENTRAL_PROFILE: 'local' });
  const res = await request(app).get('/api/models');
  assert.equal(res.status, 503);
  assert.equal(calls.length, 0);
});

for (const status of [401, 403, 503]) {
  test(`gateway ${status} remains private failure, never personal or cached initial models`, async () => {
    const { app, calls } = fixture({}, () => new Response('{}', { status }));
    const res = await request(app).get('/api/models');
    assert.equal(res.status, status);
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.deepEqual(res.body, { error: 'Central model eligibility unavailable' });
    assert.equal(calls.length, 1);
  });
}

test('malformed upstream model list is not exposed or replaced', async () => {
  const { app } = fixture(
    {},
    () =>
      new Response(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'untrusted-private-model' }],
        }),
      ),
  );
  const res = await request(app).get('/api/models');
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { error: 'Central model eligibility unavailable' });
});
