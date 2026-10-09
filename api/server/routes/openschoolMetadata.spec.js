jest.mock('@librechat/api', () =>
  jest.requireActual('../../../packages/api/src/openschool/metadata'),
);
jest.mock('@librechat/data-schemas', () => ({
  createConversationMetadataQuery: jest.fn(() => jest.fn().mockResolvedValue([])),
}));
const express = require('express');
const request = require('supertest');
const originalEnv = { ...process.env };
const originalFetch = global.fetch;
afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = originalFetch;
});

function app() {
  let router;
  jest.isolateModules(() => {
    router = require('./openschoolMetadata');
  });
  const server = express();
  server.use('/internal/openschool/v1/conversation-metadata', router);
  server.use(express.json({ limit: '3mb' }));
  return server;
}

test('mounted adapter remains off without explicit startup enable', async () => {
  delete process.env.OPENSCHOOL_METADATA_ENABLED;
  global.fetch = jest.fn();
  const response = await request(app())
    .post('/internal/openschool/v1/conversation-metadata/query')
    .send({ grant: 'synthetic' });
  expect(response.status).toBe(404);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('mounted adapter uses fixed validated local trust profile and isolated body limit', async () => {
  Object.assign(process.env, {
    NODE_ENV: 'development',
    OPENSCHOOL_CENTRAL_PROFILE: 'local',
    OPENSCHOOL_CENTRAL_SSO: 'true',
    OPENID_ISSUER: 'http://localhost:15480/realms/langrace-local',
    OPENID_CLIENT_ID: 'chat-local',
    OPENSCHOOL_CENTRAL_API_URL: 'http://localhost:15481',
    OPENID_REUSE_TOKENS: 'false',
    OPENSCHOOL_CENTRAL_API_KEY: 'central-synthetic-12345678901234567890',
    OPENSCHOOL_METADATA_KEY: 'metadata-synthetic-12345678901234567890',
    OPENSCHOOL_METADATA_ENABLED: 'true',
    OPENSCHOOL_CIRCLE_ADMISSION_ENABLED: 'true',
    OPENSCHOOL_METADATA_NAMESPACE: 'synthetic:local',
  });
  global.fetch = jest.fn().mockResolvedValue(
    Response.json({
      version: 1,
      audience: 'openschool-chat-metadata-v1',
      actor: '11111111-1111-4111-8111-111111111111',
      member: '11111111-1111-4111-8111-111111111111',
      circle: '22222222-2222-4222-8222-222222222222',
      owner: '111111111111111111111111',
      view: 'mine',
    }),
  );
  const server = app();
  const post = (body) =>
    request(server)
      .post('/internal/openschool/v1/conversation-metadata/query')
      .set('X-OpenSchool-Metadata-Key', process.env.OPENSCHOOL_METADATA_KEY)
      .send(body);
  expect((await post({ grant: 'synthetic' })).status).toBe(200);
  expect(global.fetch.mock.calls[0][0]).toBe(
    'http://localhost:15481/internal/central-sso/metadata/resolve',
  );
  expect((await post({ grant: 'x'.repeat(9000) })).status).toBe(413);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
