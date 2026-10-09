import mongoose from 'mongoose';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import type { Connection } from 'mongoose';
import type { CircleBinding } from './binding';
import type { MongoBindingStore, MongoBindingOptions } from './mongo';
import type { AdmissionFacts } from '../../../api/src/openschool/admission';
import { admitConversation } from '../../../api/src/openschool/admission';
import { createMongoBindingStore } from './mongo';

const binding: CircleBinding = {
  version: 1,
  key: {
    chatOwnerId: '111111111111111111111111',
    conversationId: '11111111-1111-4111-8111-111111111111',
  },
  memberId: '22222222-2222-4222-8222-222222222222',
  scope: {
    endpoint: 'OpenSchool',
    circleId: '33333333-3333-4333-8333-333333333333',
    model: 'circle-one',
  },
};

const alternate: CircleBinding = {
  ...binding,
  scope: {
    ...binding.scope,
    circleId: '44444444-4444-4444-8444-444444444444',
    model: 'circle-two',
  },
};
const facts = (candidate: CircleBinding = binding): AdmissionFacts => ({
  actor: { chatOwnerId: candidate.key.chatOwnerId, memberId: candidate.memberId },
  conversation: {
    kind: 'fresh-interactive',
    origin: 'interactive',
    chatOwnerId: candidate.key.chatOwnerId,
    finalId: { value: candidate.key.conversationId, source: 'server-generated' },
  },
  scope: { kind: 'resolved', value: candidate.scope },
});

describe.each(['standalone', 'replica-set'] as const)('%s explicit topology', (mode) => {
  const options: MongoBindingOptions = {
    namespace: 'synthetic-deployment:tenant-one',
    timeoutMS: 2000,
    topology: mode === 'standalone' ? { mode } : { mode, setName: 'synthetic-bindings' },
  };
  let server: MongoMemoryReplSet | MongoMemoryServer | undefined;
  let connection: Connection;
  let store: MongoBindingStore;

  beforeAll(async () => {
    // Explicit cached/local binary ONLY. Never fall back to a download or an application URI.
    const systemBinary = process.env.MONGOMS_SYSTEM_BINARY;
    if (!systemBinary) {
      throw new Error('Set MONGOMS_SYSTEM_BINARY to an existing local mongod for synthetic tests');
    }
    server =
      mode === 'standalone'
        ? await MongoMemoryServer.create({
            binary: { systemBinary },
            instance: {
              ip: '127.0.0.1',
              storageEngine: 'wiredTiger',
              args: ['--setParameter', 'enableTestCommands=1'],
            },
          })
        : await MongoMemoryReplSet.create({
            binary: { systemBinary },
            replSet: {
              count: 1,
              name: 'synthetic-bindings',
              ip: '127.0.0.1',
              storageEngine: 'wiredTiger',
            },
            instanceOpts: [{ args: ['--setParameter', 'enableTestCommands=1'] }],
          });
    connection = await mongoose
      .createConnection(server.getUri(), {
        dbName: 'synthetic_binding_tests',
        serverSelectionTimeoutMS: 2000,
        socketTimeoutMS: 3000,
      })
      .asPromise();
    store = createMongoBindingStore(connection, options);
  }, 60000);

  afterEach(async () => {
    if (connection?.readyState === 1) {
      await connection.db!.admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
      await connection.collection('openschoolbindings').deleteMany({});
    }
  });

  afterAll(async () => {
    await connection?.close();
    await server?.stop();
  });

  async function failCommand(command: string): Promise<void> {
    await connection.db!.admin().command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: [command], errorCode: 2 },
    });
  }

  test('persists across independent connections, using the mandatory unique _id index', async () => {
    expect(await admitConversation(facts(), store)).toEqual({ kind: 'admitted', binding });
    const second = await mongoose
      .createConnection(server!.getUri(), {
        dbName: 'synthetic_binding_tests',
        serverSelectionTimeoutMS: 2000,
      })
      .asPromise();
    try {
      expect(await createMongoBindingStore(second, options).read(binding.key)).toEqual({
        kind: 'bound',
        binding,
      });
      const indexes = await second.collection('openschoolbindings').indexes();
      expect(indexes).toEqual([expect.objectContaining({ name: '_id_', key: { _id: 1 } })]);
    } finally {
      await second.close();
    }
  });

  test('parallel admissions with different scopes select exactly one immutable winner', async () => {
    const other = createMongoBindingStore(connection, options);
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        admitConversation(facts(i % 2 ? alternate : binding), i % 2 ? other : store),
      ),
    );
    const winner = await store.read(binding.key);
    expect(winner.kind).toBe('bound');
    if (winner.kind !== 'bound') {
      throw new Error('Missing winner');
    }
    results.forEach((result, i) => {
      expect(result).toEqual(
        (i % 2 ? alternate : binding).scope.model === winner.binding.scope.model
          ? { kind: 'admitted', binding: winner.binding }
          : { kind: 'denied', reason: 'scope-mismatch' },
      );
    });
    expect(await connection.collection('openschoolbindings').countDocuments({})).toBe(1);
  });

  test('parallel identical retries are idempotent', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => admitConversation(facts(), store)),
    );
    expect(results.every((result) => result.kind === 'admitted')).toBe(true);
    expect(await connection.collection('openschoolbindings').countDocuments({})).toBe(1);
  });

  test('explicit namespace and exact owner isolate records', async () => {
    await store.insertIfAbsent(binding);
    const other = createMongoBindingStore(connection, {
      ...options,
      namespace: 'synthetic-deployment:tenant-two',
    });
    expect(await other.read(binding.key)).toEqual({ kind: 'absent' });
    await other.tombstone(binding.key);
    expect(await store.read(binding.key)).toEqual({ kind: 'bound', binding });
    expect(await store.read({ ...binding.key, chatOwnerId: 'aaaaaaaaaaaaaaaaaaaaaaaa' })).toEqual({
      kind: 'absent',
    });
  });

  test.each(['interactive', 'import', 'fork', 'duplicate'] as const)(
    'legacy %s origin never creates a binding',
    async (origin) => {
      const existing: AdmissionFacts = {
        ...facts(),
        conversation: {
          kind: 'existing-unbound',
          origin,
          chatOwnerId: binding.key.chatOwnerId,
          finalId: { value: binding.key.conversationId, source: 'persisted' },
        },
      };
      expect(await admitConversation(existing, store)).toEqual({ kind: 'unbound' });
      expect(await store.read(binding.key)).toEqual({ kind: 'absent' });
    },
  );

  test.each([false, true])(
    'permanent tombstone rejects ID reuse (previously bound=%s)',
    async (bound) => {
      if (bound) {
        await store.insertIfAbsent(binding);
      }
      await store.tombstone(binding.key);
      await store.tombstone(binding.key);
      await store.insertIfAbsent(alternate);
      expect(await store.read(binding.key)).toEqual({ kind: 'tombstone', key: binding.key });
      expect(await admitConversation(facts(), store)).toEqual({
        kind: 'denied',
        reason: 'tombstoned',
      });
      const row = await connection.collection('openschoolbindings').findOne({});
      expect(row).not.toHaveProperty('memberId');
      expect(row).not.toHaveProperty('circleId');
    },
  );

  test('racing insert and retirement always leave a tombstone, also after reconnect', async () => {
    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        i % 2 ? store.tombstone(binding.key) : store.insertIfAbsent(binding),
      ),
    );
    const second = await mongoose
      .createConnection(server!.getUri(), { dbName: 'synthetic_binding_tests' })
      .asPromise();
    try {
      const reopened = createMongoBindingStore(second, options);
      await reopened.insertIfAbsent(alternate);
      expect(await reopened.read(binding.key)).toEqual({ kind: 'tombstone', key: binding.key });
    } finally {
      await second.close();
    }
  });

  test.each(['find', 'update'])(
    'Mongo %s error fails closed without claiming admission',
    async (command) => {
      await failCommand(command);
      expect(await admitConversation(facts(), store)).toEqual({
        kind: 'denied',
        reason: 'storage-unavailable',
      });
      expect(await store.read(binding.key)).toEqual({ kind: 'absent' });
    },
  );

  test('failed readback after durable insert denies; retry can observe the winner', async () => {
    const result = await admitConversation(facts(), {
      read: store.read,
      insertIfAbsent: async (candidate) => {
        await store.insertIfAbsent(candidate);
        await failCommand('find');
      },
    });
    expect(result).toEqual({ kind: 'denied', reason: 'storage-unavailable' });
    expect(await admitConversation(facts(), store)).toEqual({ kind: 'admitted', binding });
  });

  test('failed retirement throws and does not falsely report a fence', async () => {
    await store.insertIfAbsent(binding);
    await failCommand('update');
    await expect(store.tombstone(binding.key)).rejects.toThrow('Binding retirement failed');
    expect(await store.read(binding.key)).toEqual({ kind: 'bound', binding });
  });

  test('unconfirmed retirement throws even if its tombstone is already durable', async () => {
    await store.insertIfAbsent(binding);
    await failCommand('find');
    await expect(store.tombstone(binding.key)).rejects.toThrow('Binding retirement failed');
    await store.insertIfAbsent(binding);
    expect(await store.read(binding.key)).toEqual({ kind: 'tombstone', key: binding.key });
  });

  test('duplicate-key error without a readable winner is not treated as success', async () => {
    await connection.db!.admin().command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: ['update'], errorCode: 11000 },
    });
    expect(await admitConversation(facts(), store)).toEqual({
      kind: 'denied',
      reason: 'storage-unavailable',
    });
    expect(await store.read(binding.key)).toEqual({ kind: 'absent' });
  });

  test('uncertain write concern denies admission even when the insert reached Mongo', async () => {
    await connection.db!.admin().command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: {
        failCommands: ['update'],
        writeConcernError: { code: 64, errmsg: 'Synthetic acknowledgement failure' },
      },
    });
    expect(await admitConversation(facts(), store)).toEqual({
      kind: 'denied',
      reason: 'storage-unavailable',
    });
    expect(await store.read(binding.key)).toEqual({ kind: 'bound', binding });
    expect(await admitConversation(facts(), store)).toEqual({ kind: 'admitted', binding });
  });

  test.each([{ state: 'future' }, { version: 2 }, { memberId: 'invalid' }, { namespace: 'wrong' }])(
    'malformed stored metadata fails closed: %p',
    async (corruption) => {
      await store.insertIfAbsent(binding);
      await connection.collection('openschoolbindings').updateOne({}, { $set: corruption });
      expect(await admitConversation(facts(), store)).toEqual({
        kind: 'denied',
        reason: 'storage-unavailable',
      });
    },
  );

  test('disconnected storage never means absent and cannot report insert or retirement success', async () => {
    const disconnected = mongoose.createConnection();
    const offline = createMongoBindingStore(disconnected, options);
    expect(await offline.read(binding.key)).toEqual({ kind: 'error' });
    await expect(offline.insertIfAbsent(binding)).rejects.toThrow();
    await expect(offline.tombstone(binding.key)).rejects.toThrow();
    await disconnected.close();
  });

  test('invalid configuration and malformed writes are rejected before persistence', async () => {
    expect(() => createMongoBindingStore(connection, { ...options, namespace: '' })).toThrow();
    expect(() => createMongoBindingStore(connection, { ...options, timeoutMS: 0 })).toThrow();
    await expect(store.insertIfAbsent({ ...binding, memberId: 'invalid' })).rejects.toThrow();
    await expect(store.tombstone({ ...binding.key, conversationId: 'invalid' })).rejects.toThrow();
    expect(await store.read(binding.key)).toEqual({ kind: 'absent' });
  });

  test('wrong configured topology fails closed on all operations without fallback', async () => {
    const wrong = createMongoBindingStore(connection, {
      ...options,
      topology:
        mode === 'standalone'
          ? { mode: 'replica-set', setName: 'synthetic-bindings' }
          : { mode: 'standalone' },
    });
    expect(await wrong.read(binding.key)).toEqual({ kind: 'error' });
    await expect(wrong.insertIfAbsent(binding)).rejects.toThrow();
    await expect(wrong.tombstone(binding.key)).rejects.toThrow();
    expect(await store.read(binding.key)).toEqual({ kind: 'absent' });
  });

  test('replica set name must match exactly', async () => {
    const wrong = createMongoBindingStore(connection, {
      ...options,
      topology: { mode: 'replica-set', setName: 'wrong-set' },
    });
    expect(await wrong.read(binding.key)).toEqual({ kind: 'error' });
    await expect(wrong.insertIfAbsent(binding)).rejects.toThrow();
  });

  test('hello errors after prior success do not reuse cached topology or downgrade', async () => {
    await store.insertIfAbsent(binding);
    await failCommand('hello');
    expect(await admitConversation(facts(), store)).toEqual({
      kind: 'denied',
      reason: 'storage-unavailable',
    });
    await failCommand('hello');
    await expect(store.insertIfAbsent(alternate)).rejects.toThrow();
    await failCommand('hello');
    await expect(store.tombstone(binding.key)).rejects.toThrow();
    expect(await store.read(binding.key)).toEqual({ kind: 'bound', binding });
  });

  test('topology selection is mandatory and snapshotted from trusted startup configuration', async () => {
    expect(() =>
      createMongoBindingStore(connection, {
        ...options,
        topology: undefined,
      } as unknown as MongoBindingOptions),
    ).toThrow();
    const config: MongoBindingOptions = { ...options, topology: { ...options.topology } };
    const fixed = createMongoBindingStore(connection, config);
    config.topology = { mode: 'replica-set', setName: 'wrong-set' };
    await fixed.insertIfAbsent(binding);
    expect(await fixed.read(binding.key)).toEqual({ kind: 'bound', binding });
  });

  test('wire commands use explicit read and journaled write concerns for the chosen mode', async () => {
    const monitored = await mongoose
      .createConnection(server!.getUri(), {
        dbName: 'synthetic_binding_tests',
        monitorCommands: true,
        serverSelectionTimeoutMS: 2000,
      })
      .asPromise();
    const seen: { commandName: string; command: Record<string, unknown> }[] = [];
    monitored.getClient().on('commandStarted', (event) => seen.push(event));
    try {
      const checked = createMongoBindingStore(monitored, options);
      await checked.insertIfAbsent(binding);
      await checked.read(binding.key);
      expect(seen.find((e) => e.commandName === 'update')?.command.writeConcern).toEqual(
        expect.objectContaining({ w: mode === 'standalone' ? 1 : 'majority', j: true }),
      );
      expect(seen.find((e) => e.commandName === 'find')?.command.readConcern).toEqual({
        level: mode === 'standalone' ? 'local' : 'linearizable',
      });
      expect(seen.filter((e) => e.commandName === 'hello')).toHaveLength(2);
    } finally {
      await monitored.close();
    }
  });
});
