import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import type { Connection } from 'mongoose';
import type { CircleBinding } from './binding';
import type { MongoBindingStore } from './mongo';
import { createMongoBindingStore } from './mongo';

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
});
