import { Schema } from 'mongoose';
import type { Connection, Model as MongoModel } from 'mongoose';
import type { BindingKey, CircleBinding, BindingRead, BindingStore } from './binding';

interface BindingRow {
  _id: string;
  namespace: string;
  chatOwnerId: string;
  conversationId: string;
  state: 'bound' | 'tombstone';
  version?: number;
  memberId?: string;
  endpoint?: string;
  circleId?: string;
  model?: string;
}

export interface MongoBindingOptions {
  /** Trusted startup configuration only. No autodetection, request override or fallback. */
  topology: { mode: 'standalone' } | { mode: 'replica-set'; setName: string };
  /** Server-selected deployment + tenant namespace; never browser or project input. */
  namespace: string;
  /** Injected deadline; controller integration must supply configured values. */
  timeoutMS: number;
}

export interface MongoBindingStore extends BindingStore {
  /** Permanent, idempotent reservation, including when no binding exists yet. */
  tombstone(key: BindingKey): Promise<void>;
}

const ownerPattern = /^[0-9a-f]{24}$/;
const guidPattern =
  /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const modelPattern = /^circle-[a-z0-9-]{1,64}$/;

function matches(pattern: RegExp, value: string): boolean {
  return typeof value === 'string' && value === value.trim() && pattern.test(value);
}

function validKey(key: BindingKey): boolean {
  return (
    key != null &&
    matches(ownerPattern, key.chatOwnerId) &&
    matches(guidPattern, key.conversationId)
  );
}

function validBinding(binding: CircleBinding): boolean {
  return (
    binding != null &&
    binding.version === 1 &&
    validKey(binding.key) &&
    matches(guidPattern, binding.memberId) &&
    binding.scope != null &&
    binding.scope.endpoint === 'OpenSchool' &&
    matches(guidPattern, binding.scope.circleId) &&
    matches(modelPattern, binding.scope.model)
  );
}

function duplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

/**
 * Opt-in factory; never registers with application startup. Uses an explicit namespace instead
 * of ambient tenant middleware (whose unscoped mode can allow global access). Every operation
 * includes the namespace in its deterministic identity. No model/collection escapes this API.
 *
 * Mongo's mandatory unique _id index is the ONLY required index: JSON tuple encoding is
 * collision-free and has no asynchronous secondary-index build window. No TTL or delete API.
 * Explicit standalone mode uses primary/local reads and journaled w:1 single-document writes.
 * It protects normal single-server ordering, NOT multinode failover or backup restoration.
 * Replica mode retains journaled majority writes and primary/linearizable reads. Both require
 * an unsharded collection; hello is checked before each operation, without fallback. The caller
 * must keep the trusted connection/topology stable (hello is not a lease). Connection selection/socket
 * deadlines remain the connection owner's responsibility in addition to operation timeoutMS.
 *
 * Tombstones cannot be revived through this adapter. Direct DB writes, collection drops,
 * restoring old backups and changing namespaces are outside this guarantee. Admission is not
 * a lease: controllers must fence trusted ID creation/imports and deletion vs subsequent effects.
 */
export function createMongoBindingStore(
  connection: Connection,
  options: MongoBindingOptions,
): MongoBindingStore {
  const { namespace, timeoutMS } = options;
  const mode = options.topology?.mode;
  const setName = options.topology?.mode === 'replica-set' ? options.topology.setName : undefined;
  if (
    typeof namespace !== 'string' ||
    !namespace.trim() ||
    namespace !== namespace.trim() ||
    namespace.length > 200 ||
    !Number.isSafeInteger(timeoutMS) ||
    timeoutMS <= 0 ||
    (mode !== 'standalone' && mode !== 'replica-set') ||
    (mode === 'replica-set' &&
      (typeof setName !== 'string' || !setName.trim() || setName !== setName.trim()))
  ) {
    throw new Error('Invalid binding store configuration');
  }
  const schema = new Schema<BindingRow>(
    {
      _id: { type: String, required: true },
      namespace: { type: String, required: true, immutable: true },
      chatOwnerId: { type: String, required: true, immutable: true },
      conversationId: { type: String, required: true, immutable: true },
      state: { type: String, required: true, enum: ['bound', 'tombstone'] },
      version: Number,
      memberId: String,
      endpoint: String,
      circleId: String,
      model: String,
    },
    {
      versionKey: false,
      strict: 'throw',
      bufferCommands: false,
      autoCreate: false,
      autoIndex: false,
      collation: { locale: 'simple' },
    },
  );
  const Model =
    (connection.models.OpenSchoolBinding as MongoModel<BindingRow> | undefined) ??
    connection.model<BindingRow>('OpenSchoolBinding', schema, 'openschoolbindings');
  const writeOptions = {
    upsert: true,
    runValidators: true,
    maxTimeMS: timeoutMS,
    timeoutMS,
    writeConcern: {
      w: mode === 'standalone' ? 1 : ('majority' as const),
      j: true,
      wtimeout: timeoutMS,
    },
  };

  async function checkTopology(): Promise<void> {
    if (connection.readyState !== 1 || !connection.db) {
      throw new Error('Binding connection unavailable');
    }
    const hello = await connection.db.command(
      { hello: 1, maxTimeMS: timeoutMS },
      { readPreference: 'primary', timeoutMS },
    );
    if (
      hello.ok !== 1 ||
      hello.isWritablePrimary !== true ||
      hello.msg != null ||
      hello.serviceId != null ||
      hello.isreplicaset === true
    ) {
      throw new Error('Unsupported binding topology');
    }
    if (mode === 'replica-set') {
      if (hello.setName !== setName) {
        throw new Error('Binding replica set mismatch');
      }
      return;
    }
    if ('setName' in hello || 'hosts' in hello || 'passives' in hello || 'arbiters' in hello) {
      throw new Error('Binding standalone topology mismatch');
    }
  }

  function identity(
    key: BindingKey,
  ): Pick<BindingRow, '_id' | 'namespace' | 'chatOwnerId' | 'conversationId'> {
    if (!validKey(key)) {
      throw new Error('Invalid binding key');
    }
    return {
      _id: JSON.stringify([namespace, key.chatOwnerId, key.conversationId]),
      namespace,
      chatOwnerId: key.chatOwnerId,
      conversationId: key.conversationId,
    };
  }

  async function read(key: BindingKey): Promise<BindingRead> {
    try {
      const filter = identity(key);
      await checkTopology();
      const row = await Model.findById(filter._id)
        .read('primary')
        .readConcern(mode === 'standalone' ? 'local' : 'linearizable')
        .setOptions({ maxTimeMS: timeoutMS, timeoutMS })
        .lean()
        .exec();
      if (!row) {
        return { kind: 'absent' };
      }
      if (
        row.namespace !== namespace ||
        row.chatOwnerId !== filter.chatOwnerId ||
        row.conversationId !== filter.conversationId
      ) {
        return { kind: 'error' };
      }
      const storedKey = { chatOwnerId: row.chatOwnerId, conversationId: row.conversationId };
      if (row.state === 'tombstone') {
        return { kind: 'tombstone', key: storedKey };
      }
      const binding: CircleBinding = {
        version: 1,
        key: storedKey,
        memberId: row.memberId ?? '',
        scope: {
          endpoint: row.endpoint ?? '',
          circleId: row.circleId ?? '',
          model: row.model ?? '',
        },
      };
      if (row.state !== 'bound' || row.version !== 1 || !validBinding(binding)) {
        return { kind: 'error' };
      }
      return { kind: 'bound', binding };
    } catch {
      return { kind: 'error' };
    }
  }

  async function insertIfAbsent(binding: CircleBinding): Promise<void> {
    if (!validBinding(binding)) {
      throw new Error('Invalid binding');
    }
    const row: BindingRow = {
      ...identity(binding.key),
      state: 'bound',
      version: 1,
      memberId: binding.memberId,
      endpoint: binding.scope.endpoint,
      circleId: binding.scope.circleId,
      model: binding.scope.model,
    };
    try {
      await checkTopology();
      await Model.updateOne({ _id: row._id }, { $setOnInsert: row }, writeOptions).exec();
    } catch (error) {
      if (!duplicateKey(error)) {
        throw new Error('Binding insert failed');
      }
      // Only a confirmed durable winner makes a duplicate-key conflict harmless.
      const winner = await read({
        chatOwnerId: row.chatOwnerId,
        conversationId: row.conversationId,
      });
      if (winner.kind !== 'bound' && winner.kind !== 'tombstone') {
        throw new Error('Binding conflict could not be read');
      }
    }
  }

  async function tombstone(key: BindingKey): Promise<void> {
    const row = identity(key);
    const snapshot = { chatOwnerId: row.chatOwnerId, conversationId: row.conversationId };
    // Concurrent first insert may win the upsert race; retry once to retire that winner.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await checkTopology();
        await Model.updateOne(
          { _id: row._id },
          {
            $setOnInsert: row,
            $set: { state: 'tombstone' },
            $unset: { version: '', memberId: '', endpoint: '', circleId: '', model: '' },
          },
          writeOptions,
        ).exec();
        if ((await read(snapshot)).kind !== 'tombstone') {
          throw new Error('Tombstone could not be confirmed');
        }
        return;
      } catch (error) {
        if (attempt === 1 || !duplicateKey(error)) {
          throw new Error('Binding retirement failed');
        }
      }
    }
  }

  return { read, insertIfAbsent, tombstone };
}
