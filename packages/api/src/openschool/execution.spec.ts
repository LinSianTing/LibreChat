import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { CircleBinding, BindingRead, MongoBindingStore } from '@librechat/data-schemas';
import { createCircleExecution, circleExecutionOptions } from './execution';

const owner = '111111111111111111111111';
const member = '22222222-2222-4222-8222-222222222222';
const circle = '33333333-3333-4333-8333-333333333333';
const scope = { endpoint: 'OpenSchool', circleId: circle, model: 'circle-a' };
const user = { id: owner, memberId: member };
const request = (body: Record<string, unknown> = {}) => ({
  user,
  path: '/',
  body: {
    endpoint: 'OpenSchool',
    model: 'circle-a',
    conversationId: 'new',
    endpointOption: { endpoint: 'OpenSchool', model_parameters: { model: 'circle-a' } },
    ...body,
  },
});
function response() {
  return Object.assign(new EventEmitter(), { status: jest.fn().mockReturnThis(), json: jest.fn() });
}
function fixture(enabled = true, enforceExisting = false) {
  const rows = new Map<string, BindingRead>();
  const occupied = new Map<string, Set<string>>();
  const store: MongoBindingStore = {
    reserveImport: jest.fn(async (key, operation) => {
      if (rows.has(key.conversationId)) return false;
      rows.set(key.conversationId, { kind: 'unbound', key, pending: true });
      occupied.set(key.conversationId, new Set([operation]));
      return true;
    }),
    occupancy: jest.fn(async (key) => [...(occupied.get(key.conversationId) ?? [])]),
    reconcileRetired: jest.fn(async () => false),
    read: jest.fn(async (key) => rows.get(key.conversationId) ?? { kind: 'absent' as const }),
    insertIfAbsent: jest.fn(async (binding) => {
      if (!rows.has(binding.key.conversationId))
        rows.set(binding.key.conversationId, { kind: 'bound', binding });
    }),
    acquire: jest.fn(async (binding, operation) => {
      if (rows.get(binding.key.conversationId)?.kind !== 'bound') return false;
      const ops = occupied.get(binding.key.conversationId) ?? new Set<string>();
      ops.add(operation);
      occupied.set(binding.key.conversationId, ops);
      return true;
    }),
    release: jest.fn(async (key, operation) => {
      occupied.get(key.conversationId)?.delete(operation);
    }),
    tombstone: jest.fn(async (key) => {
      rows.set(key.conversationId, { kind: 'tombstone', key });
    }),
    idle: jest.fn(async (key) => !occupied.get(key.conversationId)?.size),
    ownerKeys: jest.fn(async () =>
      [...rows.keys()].map((conversationId) => ({ chatOwnerId: owner, conversationId })),
    ),
  };
  const presence = jest.fn(async () => 'absent' as 'absent' | 'owned' | 'foreign');
  const catalog = jest.fn(async (_user, model) => ({
    kind: 'resolved' as const,
    value: { ...scope, model },
  }));
  const report = jest.fn();
  const runtime = createCircleExecution({
    enabled,
    enforceExisting,
    store: () => store,
    presence,
    scope: catalog,
    report,
  });
  const bind = (id = randomUUID(), changes: Partial<CircleBinding> = {}) => {
    const binding: CircleBinding = {
      version: 1,
      key: { chatOwnerId: owner, conversationId: id },
      memberId: member,
      scope,
      ...changes,
    };
    rows.set(id, { kind: 'bound', binding });
    return id;
  };
  const prepare = async (req = request()) => {
    const res = response(),
      effect = jest.fn(async () => undefined);
    await runtime.beforeOptions(
      req,
      res,
      { endpoint: req.body.endpoint, model: req.body.model },
      effect,
    );
    return { req, res, effect };
  };
  return { runtime, store, rows, occupied, presence, catalog, report, bind, prepare };
}

describe('controller circle execution coordination', () => {
  test('unrelated child lease cleanup failure still releases completed circle occupancy', async () => {
    const f = fixture();
    const { req } = await f.prepare();
    await expect(
      f.runtime.complete(req, [Promise.resolve()], async () => {
        throw new Error('child lease failure');
      }),
    ).rejects.toThrow('child lease failure');
    expect(f.store.release).toHaveBeenCalledTimes(1);
  });
  test('uncertain trailing persistence retains occupancy even after provider completion', async () => {
    const f = fixture();
    const { req } = await f.prepare();
    await f.runtime.complete(
      req,
      [Promise.reject(new Error('ambiguous write'))],
      async () => undefined,
    );
    expect(f.store.release).not.toHaveBeenCalled();
  });
  test('creation OFF retains existing binding guard and deletion fence for configured namespace', async () => {
    expect(
      circleExecutionOptions({ OPENSCHOOL_METADATA_NAMESPACE: 'synthetic' }).enforceExisting,
    ).toBe(true);
    const f = fixture(false, true);
    const id = f.bind();
    f.catalog.mockResolvedValue({ kind: 'resolved', value: { ...scope, circleId: randomUUID() } });
    expect((await f.prepare(request({ conversationId: id }))).effect).not.toHaveBeenCalled();
    expect((await f.prepare()).effect).toHaveBeenCalled();
    expect(f.store.insertIfAbsent).not.toHaveBeenCalled();
    await f.runtime.retire(owner, [id]);
    expect(f.rows.get(id)?.kind).toBe('tombstone');
  });
  test('default OFF performs no storage or catalog IO', async () => {
    expect(circleExecutionOptions({}).enabled).toBe(false);
    const f = fixture(false);
    const { effect } = await f.prepare();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(f.store.read).not.toHaveBeenCalled();
    expect(f.catalog).not.toHaveBeenCalled();
  });
  test('server final ID is stable for retry and browser new/circle/project claims are not facts', async () => {
    const f = fixture();
    const a = await f.prepare(
      request({
        clientRequestId: 'retry:1',
        circleId: randomUUID(),
        chatProjectId: 'untrusted',
        new: false,
      }),
    );
    const id = f.runtime.finalId(a.req, 'unused');
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(f.rows.get(id)).toMatchObject({ kind: 'bound', binding: { scope } });
    await f.runtime.release(a.req);
    const b = await f.prepare(request({ clientRequestId: 'retry:1' }));
    expect(f.runtime.finalId(b.req, 'unused')).toBe(id);
    expect(b.effect).toHaveBeenCalled();
    expect(f.store.insertIfAbsent).toHaveBeenCalledTimes(1);
    expect(f.catalog).toHaveBeenCalledTimes(2);
  });
  test.each(['circle', 'endpoint', 'member', 'personal'])(
    '%s mismatch rejects before project/history/save/provider callback',
    async (kind) => {
      const f = fixture();
      const id = f.bind();
      const req = request({ conversationId: id });
      if (kind === 'circle')
        f.catalog.mockResolvedValue({
          kind: 'resolved',
          value: { ...scope, circleId: randomUUID() },
        });
      if (kind === 'endpoint') req.body.endpoint = 'assistants';
      if (kind === 'personal') req.body.model = 'personal';
      if (kind === 'member') req.user = { ...user, memberId: randomUUID() };
      const { res, effect } = await f.prepare(req);
      expect(effect).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalled();
      expect(f.store.acquire).not.toHaveBeenCalled();
    },
  );
  test('same circle model change keeps stored binding scope and reauthorizes fresh catalog', async () => {
    const f = fixture();
    const id = f.bind();
    const { effect } = await f.prepare(request({ conversationId: id, model: 'circle-alias' }));
    expect(effect).toHaveBeenCalled();
    expect(f.rows.get(id)).toMatchObject({ binding: { scope } });
    expect(f.store.insertIfAbsent).not.toHaveBeenCalled();
  });
  test.each(['import', 'fork', 'duplicate', 'legacy'])(
    '%s persisted new ID stays unbound and original binding remains',
    async () => {
      const f = fixture();
      const original = f.bind();
      const copy = randomUUID();
      f.presence.mockResolvedValue('owned');
      const { effect } = await f.prepare(
        request({ conversationId: copy, new: true, circleId: circle }),
      );
      expect(effect).toHaveBeenCalled();
      expect(f.store.insertIfAbsent).not.toHaveBeenCalled();
      expect(f.rows.has(copy)).toBe(false);
      expect(f.rows.get(original)?.kind).toBe('bound');
      expect(f.catalog).not.toHaveBeenCalled();
    },
  );
  test('new flag cannot attribute a persisted server-ID collision', async () => {
    const f = fixture();
    f.presence.mockResolvedValue('owned');
    const { effect } = await f.prepare();
    expect(effect).toHaveBeenCalled();
    expect(f.store.insertIfAbsent).not.toHaveBeenCalled();
  });
  test('request override from bound source rejects, formal persisted copy without override accepts', async () => {
    const f = fixture();
    const original = f.bind();
    const copy = randomUUID();
    f.presence.mockResolvedValue('owned');
    const rejected = await f.prepare(
      request({ conversationId: original, overrideConvoId: `${copy}__0` }),
    );
    expect(rejected.effect).not.toHaveBeenCalled();
    expect(rejected.res.status).toHaveBeenCalledWith(409);
    const accepted = await f.prepare(request({ conversationId: copy }));
    expect(accepted.effect).toHaveBeenCalled();
    expect(f.store.insertIfAbsent).not.toHaveBeenCalled();
  });
  test('override with new placeholder cannot claim freshness', async () => {
    const f = fixture();
    const { effect } = await f.prepare(request({ overrideConvoId: randomUUID() }));
    expect(effect).not.toHaveBeenCalled();
    expect(f.store.insertIfAbsent).not.toHaveBeenCalled();
  });
  test('arbitrary nonpersisted browser ID is not legacy', async () => {
    const f = fixture();
    const { effect } = await f.prepare(request({ conversationId: randomUUID() }));
    expect(effect).not.toHaveBeenCalled();
    expect(f.store.insertIfAbsent).not.toHaveBeenCalled();
  });
  test('resume reauthorizes and tombstone prevents retry/reuse', async () => {
    const f = fixture();
    const id = f.bind();
    const req = { ...request({ conversationId: id }), path: '/resume' };
    expect((await f.prepare(req)).effect).toHaveBeenCalled();
    await f.runtime.release(req);
    await f.runtime.retire(owner, [id]);
    const retry = await f.prepare({ ...req, body: { ...req.body } });
    expect(retry.effect).not.toHaveBeenCalled();
    expect(retry.res.status).toHaveBeenCalledWith(409);
    expect(f.catalog).toHaveBeenCalledTimes(1);
  });
  test('catalog error or revocation fails before effects', async () => {
    const f = fixture();
    f.catalog.mockRejectedValue(new Error('revoked'));
    const { effect, res } = await f.prepare();
    expect(effect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(f.store.acquire).not.toHaveBeenCalled();
  });
  test('delete after prepare but before job blocks physical delete until execution drains', async () => {
    const f = fixture();
    const { req } = await f.prepare();
    const id = f.runtime.finalId(req, 'unused');
    await f.runtime.retire(owner, [id]);
    await expect(f.runtime.drained(owner, [id])).rejects.toThrow();
    await f.runtime.release(req);
    await expect(f.runtime.drained(owner, [id])).resolves.toBeUndefined();
    const { effect } = await f.prepare(request({ conversationId: id }));
    expect(effect).not.toHaveBeenCalled();
  });
  test('delete between admission and occupancy wins without any downstream effects', async () => {
    const f = fixture();
    (f.store.acquire as jest.Mock).mockResolvedValue(false);
    const { effect, res } = await f.prepare();
    expect(effect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });
  test('controller early return releases, background return retains until real completion', async () => {
    const f = fixture();
    const first = await f.prepare();
    await f.runtime.wrap(async () => undefined)(first.req, first.res);
    expect(f.store.release).toHaveBeenCalledTimes(1);
    const second = await f.prepare();
    await f.runtime.wrap(async (req) => {
      f.runtime.background(req);
    })(second.req, second.res);
    expect(f.store.release).toHaveBeenCalledTimes(1);
    second.res.emit('finish');
    expect(f.store.release).toHaveBeenCalledTimes(1);
    await f.runtime.release(second.req);
    expect(f.store.release).toHaveBeenCalledTimes(2);
  });
  test('final ID drift is rejected before loadHistory boundary', async () => {
    const f = fixture();
    const { req } = await f.prepare();
    expect(() => f.runtime.assertId(req, randomUUID())).toThrow('請另開新對話');
    expect(() => f.runtime.assertId(req, f.runtime.finalId(req, 'unused'))).not.toThrow();
  });
  test('owner deletion includes admitted IDs without persisted conversations', async () => {
    const f = fixture();
    const { req } = await f.prepare();
    const id = f.runtime.finalId(req, 'unused');
    expect(await f.runtime.retireOwner(owner)).toEqual([id]);
    await expect(f.runtime.drained(owner, [id])).rejects.toThrow();
  });
  test('release failure retains occupancy and reports uncertainty instead of pretending delete succeeded', async () => {
    const f = fixture();
    const { req, res } = await f.prepare();
    (f.store.release as jest.Mock).mockRejectedValue(new Error('uncertain'));
    await f.runtime.wrap(async () => undefined)(req, res);
    await f.runtime.retire(owner, [f.runtime.finalId(req, '')]);
    await expect(f.runtime.drained(owner, [f.runtime.finalId(req, '')])).rejects.toThrow();
    expect(f.report).toHaveBeenCalled();
  });
  test('import collision never runs writes; ambiguous import never frees occupancy', async () => {
    const f = fixture();
    const id = f.bind();
    const write = jest.fn(async () => undefined);
    await expect(f.runtime.importBatch(owner, undefined, [id], write)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
    const fresh = randomUUID();
    await expect(
      f.runtime.importBatch(owner, undefined, [fresh], async () => {
        throw new Error('uncertain');
      }),
    ).rejects.toThrow('uncertain');
    expect(f.occupied.get(fresh)?.size).toBe(1);
    expect(f.store.release).not.toHaveBeenCalled();
    await f.runtime.retire(owner, [fresh]);
    await expect(f.runtime.drained(owner, [fresh])).rejects.toThrow();
  });
  test('in-flight import cannot be adopted; completed import remains unbound', async () => {
    const f = fixture();
    const id = randomUUID();
    await f.runtime.importBatch(owner, undefined, [id], async () => {
      f.presence.mockResolvedValue('owned');
      expect((await f.prepare(request({ conversationId: id }))).effect).not.toHaveBeenCalled();
    });
    f.rows.set(id, {
      kind: 'unbound',
      key: { chatOwnerId: owner, conversationId: id },
      pending: false,
    });
    expect((await f.prepare(request({ conversationId: id }))).effect).toHaveBeenCalled();
    expect(f.catalog).not.toHaveBeenCalled();
    expect(f.store.insertIfAbsent).not.toHaveBeenCalled();
    expect(f.store.release).toHaveBeenCalledTimes(1);
  });
});
