import express from 'express';
import request from 'supertest';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MetadataScope, ConversationMetadata } from '@librechat/data-schemas';
import { createConversationMetadataRouter } from './metadata';

const key = 'synthetic-metadata-key-1234567890123456';
const scope: MetadataScope = {
  actor: '11111111-1111-4111-8111-111111111111',
  member: '11111111-1111-4111-8111-111111111111',
  circle: '22222222-2222-4222-8222-222222222222',
  owner: '111111111111111111111111',
  view: 'mine',
};
const row = (i: number): ConversationMetadata => ({
  id: `33333333-3333-4333-8333-${i.toString().padStart(12, '0')}`,
  title: 'Synthetic',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:00.000Z',
  savedUserTurns: 3,
});
function setup(env: Record<string, string | undefined> = {}) {
  let time = 1000000;
  const fetchImpl = jest.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          version: 1,
          audience: 'openschool-chat-metadata-v1',
          ...scope,
          sharingVersion: 1,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const query = jest.fn().mockResolvedValue([]);
  const resolveProfile = jest.fn(() => ({ api: 'http://fixed.synthetic' }));
  const app = express();
  app.use(
    '/internal/openschool/v1/conversation-metadata',
    createConversationMetadataRouter({
      env: {
        OPENSCHOOL_METADATA_ENABLED: 'true',
        OPENSCHOOL_METADATA_KEY: key,
        OPENSCHOOL_CENTRAL_API_KEY: 'synthetic-central-key-1234567890123456',
        OPENSCHOOL_METADATA_NAMESPACE: 'synthetic:tenant-one',
        ...env,
      },
      fetchImpl,
      resolveProfile,
      query,
      now: () => time,
    }),
  );
  const post = (body: object | string = { grant: 'opaque-synthetic-grant' }) =>
    request(app)
      .post('/internal/openschool/v1/conversation-metadata/query')
      .set('X-OpenSchool-Metadata-Key', key)
      .send(body);
  return {
    app,
    post,
    query,
    fetchImpl,
    resolveProfile,
    advance: () => {
      time += 300001;
    },
  };
}

test.each([undefined, 'false', '1', 'TRUE'])(
  'default off/exact enable returns 404: %s',
  async (enabled) => {
    const f = setup({ OPENSCHOOL_METADATA_ENABLED: enabled });
    expect((await f.post()).status).toBe(404);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  },
);
test('cookies, old central key and asserted browser identity cannot authenticate', async () => {
  const f = setup();
  const result = await request(f.app)
    .post('/internal/openschool/v1/conversation-metadata/query')
    .set('Cookie', 'token=synthetic')
    .set('X-OpenSchool-Central-Key', key)
    .send({ grant: 'x', owner: scope.owner });
  expect(result.status).toBe(401);
  expect(f.fetchImpl).not.toHaveBeenCalled();
  expect((await f.post().set('X-OpenSchool-Metadata-Key', 'wrong'.repeat(10))).status).toBe(401);
});
test.each(['short', undefined, key + '\n'])(
  'bad metadata key configuration unavailable',
  async (bad) => {
    expect((await setup({ OPENSCHOOL_METADATA_KEY: bad }).post()).status).toBe(503);
  },
);
test.each([
  { grant: 'x', owner: scope.owner },
  { grant: 'x', circle: scope.circle },
  { grant: 'x', limit: 100 },
  { grant: 'x', cursor: null },
  { grant: '' },
  {},
])('rejects unknown/invalid request fields: %p', async (input) => {
  const f = setup();
  expect((await f.post(input)).status).toBe(400);
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
test('bounds actual body bytes and rejects compressed bodies', async () => {
  const f = setup();
  expect((await f.post({ grant: 'x'.repeat(9000) })).status).toBe(413);
  expect((await f.post({ grant: 'x' }).set('Content-Encoding', 'gzip')).status).toBe(415);
  expect(f.query).not.toHaveBeenCalled();
});

test('chunked request is bounded without Content-Length', async () => {
  const f = setup();
  const server = f.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: (server.address() as AddressInfo).port,
          path: '/internal/openschool/v1/conversation-metadata/query',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-OpenSchool-Metadata-Key': key },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.write('{"grant":"');
      req.write('x'.repeat(9000));
      req.end('"}');
    });
    expect(status).toBe(413);
    expect(f.fetchImpl).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('invalid fixed profile/config never calls central or the database', async () => {
  const f = setup();
  f.resolveProfile.mockImplementation(() => {
    throw new Error('synthetic misconfiguration');
  });
  expect((await f.post()).status).toBe(503);
  expect(f.fetchImpl).not.toHaveBeenCalled();
  const missing = setup({ OPENSCHOOL_METADATA_NAMESPACE: undefined });
  expect((await missing.post()).status).toBe(503);
  expect(missing.query).not.toHaveBeenCalled();
});

test('resolver missing/incorrect content type and malformed JSON are unavailable', async () => {
  const f = setup();
  for (const response of [
    new Response('{}'),
    new Response('{}', { headers: { 'Content-Type': 'application/json-evil' } }),
    new Response('{', { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    f.fetchImpl.mockResolvedValueOnce(response);
    expect((await f.post()).status).toBe(503);
  }
  expect(f.query).not.toHaveBeenCalled();
});
test('empty mapped list is 200, query error is 503; no unbound fallback', async () => {
  const f = setup();
  const reply = await f.post();
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual({ version: 1, ...scope, items: [], nextCursor: null });
  expect(f.query).toHaveBeenCalledWith(scope, undefined);
  expect(f.fetchImpl).toHaveBeenCalledWith(
    'http://fixed.synthetic/internal/central-sso/metadata/resolve',
    expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({ grant: 'opaque-synthetic-grant' }),
      headers: {
        'Content-Type': 'application/json',
        'X-OpenSchool-Central-Key': 'synthetic-central-key-1234567890123456',
      },
      signal: expect.any(AbortSignal),
    }),
  );
  f.query.mockRejectedValueOnce(new Error('synthetic private error'));
  expect((await f.post()).status).toBe(503);
});
test.each([
  { version: 2 },
  { audience: 'other' },
  { owner: 'browser-owner' },
  { circle: null },
  { actor: '00000000-0000-0000-0000-000000000000' },
  { member: scope.circle },
  { view: 'admin' },
])('bad resolver scope fails closed: %p', async (change) => {
  const f = setup();
  f.fetchImpl.mockResolvedValueOnce(
    Response.json({ version: 1, audience: 'openschool-chat-metadata-v1', ...scope, ...change }),
  );
  expect((await f.post()).status).toBe(503);
  expect(f.query).not.toHaveBeenCalled();
});
test.each([401, 403, 500, 302])('resolver status %s cannot fall back', async (status) => {
  const f = setup();
  f.fetchImpl.mockResolvedValueOnce(new Response('{}', { status }));
  expect((await f.post()).status).toBe(status === 401 || status === 403 ? status : 503);
  expect(f.query).not.toHaveBeenCalled();
});
test('bounds chunked resolver bytes and handles timeout/network failure', async () => {
  const f = setup();
  f.fetchImpl.mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(' '.repeat(8193)));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    ),
  );
  expect((await f.post()).status).toBe(503);
  f.fetchImpl.mockRejectedValueOnce(new DOMException('synthetic timeout', 'TimeoutError'));
  expect((await f.post()).status).toBe(503);
  expect(f.query).not.toHaveBeenCalled();
});
test('title is JSON data, bounded and positively projected without full content', async () => {
  const f = setup();
  const title = '<script>alert("synthetic")</script>';
  f.query.mockResolvedValueOnce([
    { ...row(1), title, text: 'NEVER', content: 'NEVER', files: ['NEVER'] },
  ]);
  const reply = await f.post();
  expect(reply.status).toBe(200);
  expect(reply.headers['content-type']).toMatch(/^application\/json/);
  expect(reply.headers['x-content-type-options']).toBe('nosniff');
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.body.items[0]).toEqual({
    ...row(1),
    title,
    circle: scope.circle,
    owner: scope.owner,
  });
  expect(reply.text).not.toContain('<script>');
  expect(reply.text).not.toContain('NEVER');
  f.query.mockResolvedValueOnce([{ ...row(1), title: 'x'.repeat(257) }]);
  expect((await f.post()).status).toBe(503);
});
test('50+1 pagination uses opaque authenticated cursor and re-resolves grant each page', async () => {
  const f = setup();
  f.query.mockResolvedValueOnce(Array.from({ length: 51 }, (_, i) => row(i)));
  const first = await f.post();
  expect(first.body.items).toHaveLength(50);
  const cursor = first.body.nextCursor;
  expect(typeof cursor).toBe('string');
  expect(Buffer.from(cursor, 'base64url').toString()).not.toContain(scope.owner);
  expect((await f.post({ grant: 'new-grant', cursor })).status).toBe(200);
  expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  expect(f.query).toHaveBeenLastCalledWith(scope, { id: row(49).id, updatedAt: row(49).updatedAt });
  expect((await f.post({ grant: 'x', cursor: cursor.slice(0, -4) + 'AAAA' })).status).toBe(400);
  f.advance();
  expect((await f.post({ grant: 'x', cursor })).status).toBe(400);
});
test.each(['actor', 'member', 'owner', 'circle', 'view', 'namespace'])(
  'cursor cannot cross %s',
  async (field) => {
    const f = setup();
    f.query.mockResolvedValueOnce(Array.from({ length: 51 }, (_, i) => row(i)));
    const baseline = { ...scope, view: 'manager' };
    f.fetchImpl.mockResolvedValueOnce(
      Response.json({ version: 1, audience: 'openschool-chat-metadata-v1', ...baseline }),
    );
    const first = await f.post();
    const target = field === 'namespace' ? setup({ OPENSCHOOL_METADATA_NAMESPACE: 'other' }) : f;
    {
      const changes: Record<string, string> = { owner: '222222222222222222222222', view: 'mine' };
      const changed = changes[field] ?? '44444444-4444-4444-8444-444444444444';
      const other =
        field === 'namespace'
          ? baseline
          : {
              ...baseline,
              [field]: changed,
            };
      target.fetchImpl.mockResolvedValueOnce(
        Response.json({ version: 1, audience: 'openschool-chat-metadata-v1', ...other }),
      );
    }
    expect((await target.post({ grant: 'x', cursor: first.body.nextCursor })).status).toBe(400);
  },
);
test('revoked grant blocks continuation before database access', async () => {
  const f = setup();
  f.query.mockResolvedValueOnce(Array.from({ length: 51 }, (_, i) => row(i)));
  const first = await f.post();
  f.fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 403 }));
  expect((await f.post({ grant: 'x', cursor: first.body.nextCursor })).status).toBe(403);
  expect(f.query).toHaveBeenCalledTimes(1);
});
