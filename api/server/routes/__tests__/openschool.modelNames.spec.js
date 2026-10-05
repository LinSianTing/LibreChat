const express = require('express');
const request = require('supertest');

const mockModelCatalog = jest.fn();
jest.mock('~/server/services/LocalCentralSSO', () => ({
  enabled: () => process.env.OPENSCHOOL_CENTRAL_SSO === 'true',
}));
jest.mock('~/server/services/CentralGateway', () => ({
  identityHeaders: jest.fn(),
  modelCatalog: (...args) => mockModelCatalog(...args),
}));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => (req.user ? next() : res.sendStatus(401)),
  requireSameOrigin: (_req, _res, next) => next(),
}));

const router = require('../openschool');
const originalEnv = { ...process.env };
const member = {
  id: 'member',
  memberId: '11111111-1111-7111-8111-111111111111',
  centralSessionReference: '22222222-2222-7222-8222-222222222222',
};

function get(user = member) {
  const server = express();
  server.use((req, _res, next) => {
    req.user = user;
    next();
  });
  server.use('/api/openschool', router);
  return request(server).get('/api/openschool/model-names');
}

beforeEach(() => {
  mockModelCatalog.mockReset();
});
afterEach(() => {
  process.env = { ...originalEnv };
});

test('anonymous requests are rejected before any gateway call', async () => {
  process.env.OPENSCHOOL_CENTRAL_SSO = 'true';
  expect((await get(null)).status).toBe(401);
  expect(mockModelCatalog).not.toHaveBeenCalled();
});

test('central SSO returns the trusted names for the authenticated user only', async () => {
  process.env.OPENSCHOOL_CENTRAL_SSO = 'true';
  mockModelCatalog.mockResolvedValue({
    ids: ['circle-p0-sso-mock', 'personal'],
    names: { 'circle-p0-sso-mock': 'P0 SSO synthetic test circle' },
  });
  const result = await get().query({ memberId: 'forged' });
  expect(result.status).toBe(200);
  expect(result.headers['cache-control']).toBe('private, no-store');
  expect(result.body).toEqual({ names: { 'circle-p0-sso-mock': 'P0 SSO synthetic test circle' } });
  expect(mockModelCatalog).toHaveBeenCalledTimes(1);
  expect(mockModelCatalog.mock.calls[0][0]).toBe(member);
});

test('without central SSO the map is empty and the gateway is not called', async () => {
  process.env.OPENSCHOOL_CENTRAL_SSO = 'false';
  const result = await get();
  expect(result.status).toBe(200);
  expect(result.headers['cache-control']).toBe('private, no-store');
  expect(result.body).toEqual({ names: {} });
  expect(mockModelCatalog).not.toHaveBeenCalled();
});

test.each([
  [Object.assign(new Error('x'), { status: 401 }), 401],
  [new Error('down'), 503],
])('gateway failure is reported without detail', async (error, status) => {
  process.env.OPENSCHOOL_CENTRAL_SSO = 'true';
  mockModelCatalog.mockRejectedValue(error);
  const result = await get();
  expect(result.status).toBe(status);
  expect(result.body).toEqual({ error: 'Central model eligibility unavailable' });
});
