export type CircleScope = Readonly<{
  endpoint: string;
  circleId: string;
  model: string;
}>;

export type BindingKey = Readonly<{ chatOwnerId: string; conversationId: string }>;
export type CircleBinding = Readonly<{
  version: 1;
  key: BindingKey;
  memberId: string;
  scope: CircleScope;
}>;

export type BindingRead =
  | { kind: 'absent' }
  | { kind: 'bound'; binding: CircleBinding }
  | { kind: 'tombstone'; key: BindingKey }
  | { kind: 'unknown' | 'error' };

export interface BindingStore {
  /** Authoritative read, not an eventually consistent cache; failures must never mean absent. */
  read(key: BindingKey): Promise<BindingRead>;
  /**
   * Atomic, durable insert on the unique key; an existing binding OR tombstone must remain
   * untouched. Resolve on conflict, throw on failure/uncertain outcome. The caller reads back
   * the winner. Never implement as read-then-overwrite. Adapters own IO deadlines and retain
   * permanent tombstones (no TTL/reuse). Callers must fence trusted creation against imports,
   * and invoke retirement as part of a deletion fence before allowing subsequent effects.
   */
  insertIfAbsent(binding: CircleBinding): Promise<void>;
}
