const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createCentralSSO } = require('../api/server/services/LocalCentralSSO');
const handler = require('../api/server/services/CentralBrowserCheck');

function fixture(unavailable = false) {
  const env = {
    OPENSCHOOL_CENTRAL_SSO: 'true',
    NODE_ENV: 'development',
    OPENID_ISSUER: 'http://localhost:15480/realms/langrace-local',
    OPENID_CLIENT_ID: 'chat-local',
    OPENSCHOOL_CENTRAL_API_URL: 'http://localhost:15481',
    OPENSCHOOL_CENTRAL_API_KEY: 'synthetic',
    JWT_SECRET: 'test-access',
    JWT_REFRESH_SECRET: 'test-refresh',
  };
  const binding = (suffix) => ({
    reference: `11111111-1111-7111-8111-11111111111${suffix}`,
    memberId: '11111111-1111-7111-8111-111111111111',
    chatOwnerId: '111111111111111111111111',
    issuer: env.OPENID_ISSUER,
    clientId: 'chat-local',
    subject: 'synthetic-a',
    sid: `session-${suffix}`,
    expiresAtUtc: new Date(Date.now() + 300000).toISOString(),
  });
  const a = binding('1'),
    b = binding('2'),
    calls = [];
  const service = createCentralSSO({
    env,
    fetchImpl: async (url, options) => {
      calls.push(url);
      if (unavailable) return { status: 503 };
      const ref = JSON.parse(options.body).reference;
      return { status: 200, json: async () => (ref === a.reference ? a : b) };
    },
  });
  const session = (value) => ({
    _id: value.sid === 'session-1' ? 'aaaaaaaaaaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbbbbbbbbbb',
    user: a.chatOwnerId,
    centralSession: value,
  });
  const sign = (value, secret) =>
    jwt.sign({ id: a.chatOwnerId, sessionId: session(value)._id, centralSession: value }, secret, {
      algorithm: 'HS256',
      expiresIn: 300,
    });
  const app = express();
  app.get(
    '/api/auth/central-session-check',
    handler({
      centralSSO: service,
      verifyToken: jwt.verify,
      getUserById: async () => ({ _id: a.chatOwnerId, role: 'USER' }),
      findSession: async (query) => session(query.sessionId === 'aaaaaaaaaaaaaaaaaaaaaaaa' ? a : b),
    }),
  );
  return {
    app,
    calls,
    access: sign(a, env.JWT_SECRET),
    refreshA: sign(a, env.JWT_REFRESH_SECRET),
    refreshB: sign(b, env.JWT_REFRESH_SECRET),
  };
}
for (const [label, unavailable, mismatch, status] of [
  ['same session', false, false, 204],
  ['different browser cookie', false, true, 401],
  ['temporary authority outage', true, false, 503],
]) {
  test(`HTTP ${label} returns ${status} without cookie, refresh or revoke side effects`, async () => {
    const f = fixture(unavailable);
    const response = await request(f.app)
      .get('/api/auth/central-session-check')
      .set('Authorization', `Bearer ${f.access}`)
      .set('Cookie', `refreshToken=${mismatch ? f.refreshB : f.refreshA}`);
    assert.equal(response.status, status);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert(f.calls.every((url) => url.endsWith('/validate')));
    assert(!JSON.stringify(response.body).includes(f.access));
  });
}
test('HTTP missing/forged access or refresh is rejected without changing browser state', async () => {
  const f = fixture();
  for (const [access, refresh] of [
    ['forged', f.refreshA],
    [f.access, 'forged'],
    ['', ''],
  ]) {
    const response = await request(f.app)
      .get('/api/auth/central-session-check')
      .set('Authorization', `Bearer ${access}`)
      .set('Cookie', `refreshToken=${refresh}`);
    assert.equal(response.status, 401);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  assert(f.calls.every((url) => url.endsWith('/validate')));
});
