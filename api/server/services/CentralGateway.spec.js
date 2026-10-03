const { models, identityHeaders } = require('./CentralGateway');
const env = { ...process.env };
const originalFetch = global.fetch;
const a = {
  memberId: '11111111-1111-7111-8111-111111111111',
  centralSessionReference: '22222222-2222-7222-8222-222222222222',
};
beforeEach(() => {
  process.env.OPENSCHOOL_CENTRAL_SSO = 'true';
  process.env.NODE_ENV = 'development';
  process.env.OPENSCHOOL_GATEWAY_KEY = 'synthetic-server-key';
  process.env.OPENSCHOOL_CENTRAL_PROFILE = 'local';
  process.env.OPENID_ISSUER = 'http://localhost:15480/realms/langrace-local';
  process.env.OPENID_CLIENT_ID = 'chat-local';
  process.env.OPENSCHOOL_CENTRAL_API_URL = 'http://localhost:15481';
  process.env.OPENSCHOOL_CENTRAL_API_KEY = 'synthetic-server-key';
  process.env.OPENID_REUSE_TOKENS = 'false';
  global.fetch = jest.fn();
});
afterEach(() => {
  process.env = { ...env };
  global.fetch = originalFetch;
});
test('requires trusted member and session; no Google fallback', () => {
  expect(() => identityHeaders({ googleId: 'legacy' })).toThrow();
  expect(() => identityHeaders({ ...a, centralSessionReference: '' })).toThrow();
});
test('per-user discovery never shares results and does not fall back on failure', async () => {
  const reply = (id) =>
    new Response(JSON.stringify({ object: 'list', data: [{ id }] }), { status: 200 });
  global.fetch
    .mockResolvedValueOnce(reply('circle-a'))
    .mockResolvedValueOnce(reply('circle-b'))
    .mockResolvedValueOnce(new Response('{}', { status: 401 }));
  expect(await models(a)).toEqual({ OpenSchool: ['circle-a'] });
  const b = {
    memberId: '33333333-3333-7333-8333-333333333333',
    centralSessionReference: '44444444-4444-7444-8444-444444444444',
  };
  expect(await models(b)).toEqual({ OpenSchool: ['circle-b'] });
  await expect(models(a)).rejects.toMatchObject({ status: 401 });
  expect(global.fetch).toHaveBeenCalledTimes(3);
  expect(global.fetch.mock.calls[0][1].headers).toMatchObject(identityHeaders(a));
  expect(global.fetch.mock.calls[1][1].headers).toMatchObject(identityHeaders(b));
  expect(global.fetch.mock.calls[0][1].redirect).toBe('error');
  expect(global.fetch.mock.calls[0][0]).toBe('http://localhost:15481/ai-gateway/v1/models');
});

function demo() {
  Object.assign(process.env, {
    NODE_ENV: 'production',
    OPENSCHOOL_CENTRAL_PROFILE: 'demo',
    OPENID_ISSUER: 'https://openschool.langracetech.com/identity/realms/openschool',
    OPENID_CLIENT_ID: 'chat-demo',
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
  });
}

test('validated demo discovers only eligible models using its fixed service address', async () => {
  demo();
  global.fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ object: 'list', data: [{ id: 'circle-p0-sso-mock' }] })),
  );
  expect(await models(a)).toEqual({ OpenSchool: ['circle-p0-sso-mock'] });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][0]).toBe('http://school:8080/ai-gateway/v1/models');
  expect(global.fetch.mock.calls[0][1].headers).toMatchObject(identityHeaders(a));
  expect(global.fetch.mock.calls[0][1].redirect).toBe('error');
});

test.each([
  ['OPENSCHOOL_CENTRAL_PROFILE', 'other'],
  ['NODE_ENV', 'development'],
  ['OPENSCHOOL_CENTRAL_API_URL', 'http://localhost:15481'],
  ['OPENSCHOOL_CENTRAL_API_URL', 'https://untrusted.invalid'],
  ['OPENID_ISSUER', 'https://untrusted.invalid'],
  ['OPENID_CLIENT_ID', 'chat-local'],
  ['DOMAIN_CLIENT', 'https://openschool.langracetech.com'],
  ['OPENID_REUSE_TOKENS', 'true'],
  ['USE_REDIS', 'false'],
  ['OPENSCHOOL_GATEWAY_KEY', ''],
  ['OPENSCHOOL_CENTRAL_SSO', 'false'],
])('demo rejects invalid %s=%s before any request', async (key, value) => {
  demo();
  process.env[key] = value;
  await expect(models(a)).rejects.toThrow();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('production without the explicit demo profile remains denied', async () => {
  process.env.NODE_ENV = 'production';
  await expect(models(a)).rejects.toThrow();
  expect(global.fetch).not.toHaveBeenCalled();
});

test.each([401, 403, 500])('demo gateway %s never falls back to personal', async (status) => {
  demo();
  global.fetch.mockResolvedValueOnce(new Response('{}', { status }));
  await expect(models(a)).rejects.toMatchObject({ status: status === 500 ? 503 : status });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
