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
});
