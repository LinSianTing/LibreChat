import type {
  ConversationFacts,
  AdmissionFacts,
  CircleBinding,
  BindingStore,
  BindingRead,
  CircleScope,
  BindingKey,
} from './admission';
import { admitConversation, evaluateConversationAdmission } from './admission';

const OWNER = '100000000000000000000001';
const OTHER_OWNER = '100000000000000000000002';
const MEMBER = '10000000-0000-4000-8000-000000000001';
const CONVERSATION = '20000000-0000-4000-8000-000000000001';
const CIRCLE = '30000000-0000-4000-8000-000000000001';
const OTHER_CIRCLE = '30000000-0000-4000-8000-000000000002';
const KEY: BindingKey = { chatOwnerId: OWNER, conversationId: CONVERSATION };
const SCOPE: CircleScope = { endpoint: 'OpenSchool', circleId: CIRCLE, model: 'circle-a' };

const fresh = (scope: CircleScope = SCOPE): AdmissionFacts => ({
  actor: { chatOwnerId: OWNER, memberId: MEMBER },
  conversation: {
    kind: 'fresh-interactive',
    origin: 'interactive',
    chatOwnerId: OWNER,
    finalId: { value: CONVERSATION, source: 'server-generated' },
  },
  scope: { kind: 'resolved', value: scope },
});

const existing = (
  origin: 'interactive' | 'import' | 'fork' | 'duplicate' = 'interactive',
): AdmissionFacts => ({
  ...fresh(),
  conversation: {
    kind: 'existing-unbound',
    origin,
    chatOwnerId: OWNER,
    finalId: { value: CONVERSATION, source: 'persisted' },
  },
});

const bound = (scope: CircleScope = SCOPE): AdmissionFacts => ({
  ...fresh(scope),
  conversation: {
    kind: 'bound',
    origin: 'interactive',
    chatOwnerId: OWNER,
    finalId: { value: CONVERSATION, source: 'persisted' },
  },
});

const binding = (scope: CircleScope = SCOPE): CircleBinding => ({
  version: 1,
  key: KEY,
  memberId: MEMBER,
  scope,
});

/** Deliberately malformed adapter/JS input, not a production deserialization contract. */
const uncheckedFacts = (changes: object): AdmissionFacts =>
  JSON.parse(JSON.stringify({ ...fresh(), ...changes })) as AdmissionFacts;

/** In-memory atomic callback implementation only; no database, model calls, or real data. */
function memoryStore(initial?: BindingRead) {
  const records = new Map<string, BindingRead>();
  const calls: string[] = [];
  const keyOf = (key: BindingKey) => `${key.chatOwnerId}:${key.conversationId}`;
  if (initial) {
    records.set(keyOf(KEY), initial);
  }
  const store: BindingStore = {
    async read(key) {
      calls.push('read');
      return records.get(keyOf(key)) ?? { kind: 'absent' };
    },
    async insertIfAbsent(value) {
      calls.push('insert');
      const key = keyOf(value.key);
      if (!records.has(key)) {
        records.set(key, { kind: 'bound', binding: value });
      }
    },
  };
  return { store, calls, records };
}

describe('conversation admission policy', () => {
  it('proposes a binding without treating the proposal as admission or mutating facts', () => {
    const facts = fresh();
    const before = JSON.stringify(facts);
    expect(evaluateConversationAdmission(facts, { kind: 'absent' })).toEqual({
      kind: 'insert-if-absent',
      binding: binding(),
    });
    expect(JSON.stringify(facts)).toBe(before);
  });

  it('admits a fresh interactive ID only after atomic insertion and authoritative readback', async () => {
    const { store, calls } = memoryStore();
    await expect(admitConversation(fresh(), store)).resolves.toEqual({
      kind: 'admitted',
      binding: binding(),
    });
    expect(calls).toEqual(['read', 'insert', 'read']);
  });

  it.each(['interactive', 'import', 'fork', 'duplicate'] as const)(
    'leaves an existing %s unbound without banning the originating operation',
    async (origin) => {
      const { store, calls } = memoryStore();
      const facts = { ...existing(origin), browserNew: true, chatProjectId: 'circle-a' };
      await expect(admitConversation(facts, store)).resolves.toEqual({ kind: 'unbound' });
      expect(calls).toEqual(['read']);
    },
  );

  it.each(['import', 'fork', 'duplicate'])(
    'cannot promote a %s origin into fresh-interactive binding creation',
    async (origin) => {
      const { store, calls } = memoryStore();
      const facts = uncheckedFacts({ conversation: { ...fresh().conversation, origin } });
      await expect(admitConversation(facts, store)).resolves.toEqual({
        kind: 'denied',
        reason: 'invalid-facts',
      });
      expect(calls).toEqual([]);
    },
  );

  it.each([fresh(), bound()])(
    'accepts an already bound same-scope request without writing',
    async (facts) => {
      const { store, calls } = memoryStore({ kind: 'bound', binding: binding() });
      await expect(admitConversation(facts, store)).resolves.toEqual({
        kind: 'admitted',
        binding: binding(),
      });
      expect(calls).toEqual(['read']);
    },
  );

  it.each([
    { ...SCOPE, circleId: OTHER_CIRCLE },
    { ...SCOPE, endpoint: 'Other' },
  ])(
    'rejects scope changes on continuation AND new-request replay before any write',
    async (scope) => {
      for (const facts of [bound(scope), fresh(scope)]) {
        const { store, calls } = memoryStore({ kind: 'bound', binding: binding() });
        const result = await admitConversation(facts, store);
        expect(result.kind).toBe('denied');
        expect(calls).not.toContain('insert');
      }
    },
  );

  it.each(['unknown', 'error'] as const)('fails closed on %s conversation facts', async (kind) => {
    const { store, calls } = memoryStore();
    await expect(admitConversation({ ...fresh(), conversation: { kind } }, store)).resolves.toEqual(
      {
        kind: 'denied',
        reason: 'invalid-facts',
      },
    );
    expect(calls).toEqual([]);
  });

  it.each(['unknown', 'error'] as const)('fails closed on %s scope resolution', async (kind) => {
    const { store, calls } = memoryStore();
    await expect(admitConversation({ ...fresh(), scope: { kind } }, store)).resolves.toEqual({
      kind: 'denied',
      reason: 'scope-unavailable',
    });
    expect(calls).toEqual([]);
  });

  it.each([
    { conversation: 'new' },
    { conversation: null },
    { actor: { chatOwnerId: OTHER_OWNER, memberId: MEMBER } },
    { actor: { chatOwnerId: OWNER, memberId: '' } },
    {
      conversation: {
        ...fresh().conversation,
        finalId: { value: CONVERSATION, source: 'browser' },
      },
    },
    {
      conversation: {
        ...fresh().conversation,
        finalId: { value: 'new', source: 'server-generated' },
      },
    },
    {
      conversation: {
        ...fresh().conversation,
        finalId: { value: `${CONVERSATION}\n`, source: 'server-generated' },
      },
    },
    {
      conversation: {
        ...fresh().conversation,
        finalId: { value: '00000000-0000-0000-0000-000000000000', source: 'server-generated' },
      },
    },
    { conversation: { ...fresh().conversation, kind: 'browser-new' } },
  ])('rejects inconsistent identities/provenance before storage', async (changes) => {
    const { store, calls } = memoryStore();
    expect((await admitConversation(uncheckedFacts(changes), store)).kind).toBe('denied');
    expect(calls).toEqual([]);
  });

  it.each([
    { ...SCOPE, circleId: 'circle-a' },
    { ...SCOPE, circleId: '00000000-0000-0000-0000-000000000000' },
    { ...SCOPE, model: 'personal' },
    { ...SCOPE, model: 'circle-a\n' },
    { ...SCOPE, model: `circle-${'a'.repeat(65)}` },
  ])('does not infer a circle GUID or accept an unresolved model', async (scope) => {
    const { store, calls } = memoryStore();
    expect((await admitConversation(fresh(scope), store)).kind).toBe('denied');
    expect(calls).toEqual([]);
  });

  it.each([
    { ...binding(), key: { ...KEY, chatOwnerId: OTHER_OWNER } },
    { ...binding(), key: { ...KEY, conversationId: MEMBER } },
    { ...binding(), memberId: OTHER_CIRCLE },
  ])('rejects wrong-owner, wrong-final-ID and remapped-member readbacks', async (stored) => {
    const { store, calls } = memoryStore({ kind: 'bound', binding: stored });
    await expect(admitConversation(bound(), store)).resolves.toEqual({
      kind: 'denied',
      reason: 'binding-mismatch',
    });
    expect(calls).toEqual(['read']);
  });

  it('does not turn a missing bound record into a fresh binding', async () => {
    const { store, calls } = memoryStore();
    await expect(admitConversation(bound(), store)).resolves.toEqual({
      kind: 'denied',
      reason: 'facts-conflict',
    });
    expect(calls).toEqual(['read']);
  });

  it('rejects an unsupported binding version rather than interpreting it as absent', async () => {
    const observed = JSON.parse(
      JSON.stringify({ kind: 'bound', binding: { ...binding(), version: 2 } }),
    ) as BindingRead;
    const { store, calls } = memoryStore(observed);
    expect((await admitConversation(fresh(), store)).kind).toBe('denied');
    expect(calls).toEqual(['read']);
  });

  it('does not silently upgrade existing-unbound facts when storage disagrees', async () => {
    const { store, calls } = memoryStore({ kind: 'bound', binding: binding() });
    await expect(admitConversation(existing(), store)).resolves.toEqual({
      kind: 'denied',
      reason: 'facts-conflict',
    });
    expect(calls).toEqual(['read']);
  });

  it.each([fresh(), bound(), existing('fork')])('never reuses a tombstoned ID', async (facts) => {
    const { store, calls } = memoryStore({ kind: 'tombstone', key: KEY });
    await expect(admitConversation(facts, store)).resolves.toEqual({
      kind: 'denied',
      reason: 'tombstoned',
    });
    expect(calls).toEqual(['read']);
  });

  it.each([{ kind: 'unknown' }, { kind: 'error' }] as const)(
    'never treats uncertain storage as absence',
    async (observation) => {
      const { store, calls } = memoryStore(observation);
      await expect(admitConversation(fresh(), store)).resolves.toEqual({
        kind: 'denied',
        reason: 'storage-unavailable',
      });
      expect(calls).toEqual(['read']);
    },
  );

  it.each(['read', 'insertIfAbsent'] as const)(
    'sanitizes %s errors and does not retry',
    async (method) => {
      const { store, calls } = memoryStore();
      store[method] = async () => {
        throw new Error('synthetic private adapter detail');
      };
      await expect(admitConversation(fresh(), store)).resolves.toEqual({
        kind: 'denied',
        reason: 'storage-unavailable',
      });
      expect(calls).toEqual(method === 'read' ? [] : ['read']);
    },
  );

  it.each<BindingRead>([
    { kind: 'absent' },
    { kind: 'unknown' },
    { kind: 'error' },
    { kind: 'tombstone', key: KEY },
    { kind: 'bound', binding: binding({ ...SCOPE, circleId: OTHER_CIRCLE }) },
  ])('requires a matching authoritative winner after insertion', async (winner) => {
    let reads = 0;
    let inserts = 0;
    const store: BindingStore = {
      async read() {
        return ++reads === 1 ? { kind: 'absent' } : winner;
      },
      async insertIfAbsent() {
        inserts++;
      },
    };
    expect((await admitConversation(fresh(), store)).kind).toBe('denied');
    expect({ reads, inserts }).toEqual({ reads: 2, inserts: 1 });
  });

  it('admits only one scope in a concurrent first-claim race', async () => {
    const { store } = memoryStore();
    const results = await Promise.all([
      admitConversation(fresh(), store),
      admitConversation(fresh({ ...SCOPE, circleId: OTHER_CIRCLE, model: 'circle-b' }), store),
    ]);
    expect(results.filter((r) => r.kind === 'admitted')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'denied')).toEqual([
      { kind: 'denied', reason: 'scope-mismatch' },
    ]);
  });

  it('preserves a tombstone that wins between the initial read and atomic insert', async () => {
    const { store, records } = memoryStore();
    const insert = store.insertIfAbsent;
    store.insertIfAbsent = async (candidate) => {
      records.set(`${KEY.chatOwnerId}:${KEY.conversationId}`, { kind: 'tombstone', key: KEY });
      await insert(candidate);
    };
    await expect(admitConversation(fresh(), store)).resolves.toEqual({
      kind: 'denied',
      reason: 'tombstoned',
    });
    expect([...records.values()]).toEqual([{ kind: 'tombstone', key: KEY }]);
  });

  it('does not admit when readback throws after a durable insert', async () => {
    const { store, calls } = memoryStore();
    const read = store.read;
    let reads = 0;
    store.read = async (key) => {
      if (++reads === 2) throw new Error('readback unavailable');
      return read(key);
    };
    await expect(admitConversation(fresh(), store)).resolves.toEqual({
      kind: 'denied',
      reason: 'storage-unavailable',
    });
    expect(reads).toBe(2);
    expect(calls).toEqual(['read', 'insert']);
  });

  it('admits concurrent same-scope retries without replacing the winner', async () => {
    const { store, records } = memoryStore();
    const results = await Promise.all([
      admitConversation(fresh(), store),
      admitConversation(fresh(), store),
    ]);
    expect(results.every((r) => r.kind === 'admitted')).toBe(true);
    expect(records.size).toBe(1);
  });

  it('recovers an uncertain successful insert only through a later same-scope read', async () => {
    const { store, calls } = memoryStore();
    const insert = store.insertIfAbsent;
    store.insertIfAbsent = async (value) => {
      await insert(value);
      throw new Error('lost acknowledgement');
    };
    expect((await admitConversation(fresh(), store)).kind).toBe('denied');
    expect((await admitConversation(fresh(), store)).kind).toBe('admitted');
    expect(calls).toEqual(['read', 'insert', 'read']);
  });

  it('snapshots facts before awaiting an adapter', async () => {
    const scope = { ...SCOPE };
    const conversation: ConversationFacts = {
      kind: 'fresh-interactive',
      origin: 'interactive',
      chatOwnerId: OWNER,
      finalId: { value: CONVERSATION, source: 'server-generated' },
    };
    const facts: AdmissionFacts = { ...fresh(scope), conversation };
    const { store } = memoryStore();
    const read = store.read;
    store.read = async (key) => {
      scope.circleId = OTHER_CIRCLE;
      return read(key);
    };
    const result = await admitConversation(facts, store);
    expect(result).toEqual({ kind: 'admitted', binding: binding() });
    if (result.kind === 'admitted') {
      expect(Object.isFrozen(result.binding)).toBe(true);
      expect(Object.isFrozen(result.binding.key)).toBe(true);
      expect(Object.isFrozen(result.binding.scope)).toBe(true);
    }
  });
});
