import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import type { Connection } from 'mongoose';
import type { CircleBinding } from './binding';
import type { MongoBindingStore } from './mongo';
import { createMongoBindingStore } from './mongo';
import { createConversationMetadataQuery, conversationMetadataPipeline } from './metadata';

const docker = promisify(execFile);
const image = 'mongo@sha256:1f995ad6fdb93244a1addab1b58f934a0bc2f5643c38e02f5e9d7f0c7d227a7b';
const database = 'synthetic_openschool_binding_mongo7';
const options = {
  namespace: 'synthetic-mongo7:tenant-one',
  topology: { mode: 'standalone' as const },
  timeoutMS: 3000,
};
const binding: CircleBinding = {
  version: 1,
  key: {
    chatOwnerId: '111111111111111111111111',
    conversationId: '11111111-1111-4111-8111-111111111111',
  },
  memberId: '22222222-2222-4222-8222-222222222222',
  scope: {
    endpoint: 'OpenSchool',
    model: 'circle-synthetic',
    circleId: '33333333-3333-4333-8333-333333333333',
  },
};

/**
 * Opt in with OPENSCHOOL_MONGO7_DOCKER=1 after pulling the exact image above.
 * No supplied URI/port/database is accepted: this suite creates its own ephemeral container,
 * discovers only its loopback port, and always selects the fixed synthetic database.
 * It never downloads images, mounts host data, touches other containers, or prunes Docker.
 */
const fixtureTests = process.env.OPENSCHOOL_MONGO7_DOCKER === '1' ? describe : describe.skip;
fixtureTests('Mongo 7.0.43 standalone controlled Docker fixture', () => {
  const name = `openschool-binding-mongo7-${randomUUID()}`;
  let containerId: string | undefined;
  let port: number;
  let connection: Connection | undefined;
  let store: MongoBindingStore;

  async function connect(): Promise<Connection> {
    // Port originates exclusively from `docker port` for the container this suite created.
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Invalid synthetic fixture port');
    }
    return mongoose
      .createConnection(`mongodb://127.0.0.1:${port}/${database}`, {
        dbName: database,
        directConnection: true,
        serverSelectionTimeoutMS: 15000,
        socketTimeoutMS: 5000,
      })
      .asPromise();
  }

  beforeAll(async () => {
    const result = await docker(
      'docker',
      [
        'run',
        '--detach',
        '--rm',
        '--pull=never',
        '--name',
        name,
        '--label',
        `openschool.synthetic-fixture=${name}`,
        '--publish',
        '127.0.0.1::27017',
        '--tmpfs',
        '/data/db',
        '--tmpfs',
        '/data/configdb',
        image,
        'mongod',
        '--bind_ip_all',
        '--wiredTigerCacheSizeGB',
        '0.25',
        '--setParameter',
        'enableTestCommands=1',
      ],
      { timeout: 30000 },
    );
    containerId = result.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(containerId)) {
      throw new Error('Unexpected Docker container identity');
    }
    const published = await docker('docker', ['port', containerId, '27017/tcp'], {
      timeout: 10000,
    });
    const match = /^127\.0\.0\.1:(\d+)$/.exec(published.stdout.trim());
    if (!match) {
      throw new Error('Fixture must publish exclusively on IPv4 loopback');
    }
    port = Number(match[1]);
    connection = await connect();
    const build = await connection.db!.command({ buildInfo: 1 });
    if (build.version !== '7.0.43') {
      throw new Error('Fixture must run Mongo 7.0.43');
    }
    const hello = await connection.db!.command({ hello: 1 });
    if (hello.isWritablePrimary !== true || hello.setName !== undefined) {
      throw new Error('Fixture must be standalone');
    }
    store = createMongoBindingStore(connection, options);
  }, 60000);

  afterEach(async () => {
    if (connection?.readyState === 1) {
      await connection.db!.admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
      await connection.collection('openschoolbindings').deleteMany({});
      await connection.collection('conversations').deleteMany({});
      await connection.collection('messages').deleteMany({});
    }
  });

  afterAll(async () => {
    await connection?.close();
    // Even if docker run timed out, only retire the uniquely labelled container owned here.
    let label: string;
    try {
      const inspected = await docker(
        'docker',
        ['inspect', '--format', '{{index .Config.Labels "openschool.synthetic-fixture"}}', name],
        { timeout: 10000 },
      );
      label = inspected.stdout.trim();
    } catch (error) {
      if (containerId) {
        throw error;
      }
      return;
    }
    if (label !== name) {
      throw new Error('Refusing cleanup of an unowned container');
    }
    await docker('docker', ['stop', '--time', '5', name], { timeout: 15000 });
  }, 30000);

  test('insert/readback and reconnect retain the immutable winner', async () => {
    await store.insertIfAbsent(binding);
    expect(await store.read(binding.key)).toEqual({ kind: 'bound', binding });
    await connection!.close();
    connection = await connect();
    store = createMongoBindingStore(connection, options);
    await store.insertIfAbsent({ ...binding, scope: { ...binding.scope, model: 'circle-other' } });
    expect(await store.read(binding.key)).toEqual({ kind: 'bound', binding });
  });

  test('concurrent different scopes produce exactly one durable record', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.insertIfAbsent({
          ...binding,
          scope: { ...binding.scope, model: `circle-${i}` },
        }),
      ),
    );
    const winner = await store.read(binding.key);
    expect(winner.kind).toBe('bound');
    expect(await connection!.collection('openschoolbindings').countDocuments({})).toBe(1);
    await store.insertIfAbsent(binding);
    expect(await store.read(binding.key)).toEqual(winner);
  });

  test('concurrent retirement prevents reuse, including after reconnect', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 ? store.insertIfAbsent(binding) : store.tombstone(binding.key),
      ),
    );
    await connection!.close();
    connection = await connect();
    store = createMongoBindingStore(connection, options);
    await store.insertIfAbsent(binding);
    expect(await store.read(binding.key)).toEqual({ kind: 'tombstone', key: binding.key });
  });

  test('configured replica mode is rejected on the actual standalone server', async () => {
    const wrong = createMongoBindingStore(connection!, {
      ...options,
      topology: { mode: 'replica-set', setName: 'not-a-replica' },
    });
    expect(await wrong.read(binding.key)).toEqual({ kind: 'error' });
    await expect(wrong.insertIfAbsent(binding)).rejects.toThrow();
    await expect(wrong.tombstone(binding.key)).rejects.toThrow();
    expect(await store.read(binding.key)).toEqual({ kind: 'absent' });
  });

  test('actual Mongo command failures cannot be confused with absent/success', async () => {
    const admin = connection!.db!.admin();
    await admin.command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: ['find'], errorCode: 2 },
    });
    expect(await store.read(binding.key)).toEqual({ kind: 'error' });
    await admin.command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: ['update'], errorCode: 2 },
    });
    await expect(store.insertIfAbsent(binding)).rejects.toThrow();
    expect(await store.read(binding.key)).toEqual({ kind: 'absent' });
  });

  const scope = {
    actor: binding.memberId,
    member: binding.memberId,
    owner: binding.key.chatOwnerId,
    circle: binding.scope.circleId,
    view: 'mine' as const,
  };
  const dates = {
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-09T00:00:00.000Z'),
  };
  test('metadata projects only bound owned circle conversations and counts retained distinct user turns', async () => {
    await store.insertIfAbsent(binding);
    const title = '<script>synthetic</script>' + 'x'.repeat(300);
    await connection!.collection('conversations').insertMany([
      {
        conversationId: binding.key.conversationId,
        user: scope.owner,
        title,
        ...dates,
        text: 'NEVER_READ',
        files: ['NEVER_READ'],
      },
      {
        conversationId: binding.key.conversationId,
        user: 'other-owner',
        title: 'SECRET_WRONG_OWNER',
        ...dates,
      },
      {
        conversationId: binding.key.conversationId,
        user: scope.owner,
        tenantId: 'other-tenant',
        title: 'SECRET_WRONG_TENANT',
        ...dates,
      },
      {
        conversationId: '44444444-4444-4444-8444-444444444444',
        user: scope.owner,
        chatProjectId: scope.circle,
        title: 'SECRET_UNBOUND',
        ...dates,
      },
    ]);
    const base = {
      conversationId: binding.key.conversationId,
      user: scope.owner,
      isCreatedByUser: true,
      text: 'NEVER_READ',
      content: [{ text: 'NEVER_READ' }],
      files: ['NEVER_READ'],
    };
    await connection!.collection('messages').insertMany([
      { ...base, messageId: 'q1' },
      { ...base, messageId: 'q1' },
      { ...base, messageId: 'branch-one', parentMessageId: 'p1' },
      { ...base, messageId: 'branch-two', parentMessageId: 'p2' },
      { ...base, messageId: 'regenerated-response', isCreatedByUser: false },
      { ...base, messageId: 'wrong-owner', user: 'other-owner' },
      { ...base, messageId: 'wrong-tenant', tenantId: 'other-tenant' },
      { ...base, messageId: 'wrong-conversation', conversationId: 'other' },
    ]);
    const query = createConversationMetadataQuery(connection!, options);
    expect(await query(scope)).toEqual([
      {
        id: binding.key.conversationId,
        title: title.slice(0, 256),
        createdAt: dates.createdAt.toISOString(),
        updatedAt: dates.updatedAt.toISOString(),
        savedUserTurns: 3,
      },
    ]);
    expect(await query({ ...scope, circle: '55555555-5555-4555-8555-555555555555' })).toEqual([]);
    expect(
      await createConversationMetadataQuery(connection!, { namespace: 'other' })(scope),
    ).toEqual([]);
    await connection!.collection('conversations').updateOne(
      {
        conversationId: binding.key.conversationId,
        user: scope.owner,
        tenantId: { $exists: false },
      },
      { $set: { title: 'a' + '😀'.repeat(256) } },
    );
    expect((await query(scope))[0].title).toBe('a' + '😀'.repeat(127));
    await store.tombstone(binding.key);
    expect(await query(scope)).toEqual([]);
  });

  test('binding without a surviving conversation yields no metadata; unbound titles never queried', async () => {
    await store.insertIfAbsent(binding);
    expect(await createConversationMetadataQuery(connection!, options)(scope)).toEqual([]);
    const pipeline = conversationMetadataPipeline(options.namespace, undefined, scope);
    expect(pipeline[0]).toEqual({
      $match: {
        namespace: options.namespace,
        chatOwnerId: scope.owner,
        memberId: scope.member,
        circleId: scope.circle,
        state: 'bound',
        version: 1,
        endpoint: 'OpenSchool',
      },
    });
    const serialized = JSON.stringify(pipeline);
    for (const forbidden of ['text', 'content', 'files', 'tokenCount', 'chatProjectId']) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
    expect(pipeline).toContainEqual({ $limit: 51 });
    const lookup = pipeline.filter((stage) => '$lookup' in stage);
    expect(lookup).toHaveLength(2);
    expect(JSON.stringify(lookup[1])).toContain('"$project":{"_id":0,"messageId":1}');
    expect(JSON.stringify(lookup[0])).toContain(
      '"$project":{"_id":0,"id":"$conversationId","title":',
    );
  });

  test('metadata keyset uses updatedAt descending/id ascending, fetching 50 plus one', async () => {
    for (let i = 0; i < 52; i++) {
      const id = `33333333-3333-4333-8333-${i.toString().padStart(12, '0')}`;
      await store.insertIfAbsent({ ...binding, key: { ...binding.key, conversationId: id } });
      await connection!
        .collection('conversations')
        .insertOne({ conversationId: id, user: scope.owner, title: `synthetic-${i}`, ...dates });
    }
    const query = createConversationMetadataQuery(connection!, options);
    const first = await query(scope);
    expect(first).toHaveLength(51);
    const next = await query(scope, { id: first[49].id, updatedAt: first[49].updatedAt });
    expect(next).toHaveLength(2);
    expect(next[0].id).toBe(first[50].id);
    expect(next[1].id > next[0].id).toBe(true);
  });

  test('metadata aggregate failure is an error, never a successful empty list', async () => {
    const admin = connection!.db!.admin();
    await admin.command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: ['aggregate'], errorCode: 2 },
    });
    await expect(createConversationMetadataQuery(connection!, options)(scope)).rejects.toThrow();
  });
});
