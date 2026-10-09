/**
 * Internal policy only: callers must supply freshly authorized server facts, never a request
 * body, browser `new` flag, project name, or decoded-only identity. This module authenticates
 * nobody and does not guard history/model calls until a controller integrates its result.
 * The store is scoped by the caller to one deployment/tenant identity namespace.
 */
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

type ConversationIdentity = Readonly<{
  chatOwnerId: string;
  finalId: Readonly<{ value: string; source: 'server-generated' | 'persisted' }>;
}>;

export type ConversationFacts =
  | (ConversationIdentity & {
      kind: 'fresh-interactive';
      origin: 'interactive';
      finalId: Readonly<{ value: string; source: 'server-generated' }>;
    })
  | (ConversationIdentity & {
      kind: 'existing-unbound';
      origin: 'interactive' | 'import' | 'fork' | 'duplicate';
      finalId: Readonly<{ value: string; source: 'persisted' }>;
    })
  | (ConversationIdentity & {
      kind: 'bound';
      origin: 'interactive';
      finalId: Readonly<{ value: string; source: 'persisted' }>;
    })
  | { kind: 'unknown' | 'error' };

export type AdmissionFacts = Readonly<{
  actor: Readonly<{ chatOwnerId: string; memberId: string }>;
  conversation: ConversationFacts;
  /** Resolved from the currently authorized server catalog, including a stable circle GUID. */
  scope: { kind: 'resolved'; value: CircleScope } | { kind: 'unknown' | 'error' };
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
   * the winner. Never implement as read-then-overwrite. Adapters own IO deadlines, creation
   * fencing against imports, and permanent tombstones on deletion (no TTL/reuse).
   */
  insertIfAbsent(binding: CircleBinding): Promise<void>;
}

export type AdmissionDenial = Readonly<{
  kind: 'denied';
  reason:
    | 'invalid-facts'
    | 'owner-mismatch'
    | 'scope-unavailable'
    | 'scope-mismatch'
    | 'binding-mismatch'
    | 'facts-conflict'
    | 'tombstoned'
    | 'storage-unavailable';
}>;

export type AdmissionResult =
  | AdmissionDenial
  | Readonly<{ kind: 'admitted'; binding: CircleBinding }>
  /** Preserve the legacy path; this is neither circle attribution nor permission to call a model. */
  | Readonly<{ kind: 'unbound' }>;

export type AdmissionDecision =
  | AdmissionResult
  | Readonly<{ kind: 'insert-if-absent'; binding: CircleBinding }>;

type PreparedFacts = Readonly<{
  kind: 'fresh-interactive' | 'existing-unbound' | 'bound';
  binding: CircleBinding;
}>;

const OWNER = /^[0-9a-f]{24}$/;
const GUID =
  /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MODEL = /^circle-[a-z0-9-]{1,64}$/;
const deny = (reason: AdmissionDenial['reason']): AdmissionDenial => ({ kind: 'denied', reason });
const matches = (pattern: RegExp, value: string): boolean =>
  typeof value === 'string' && value === value.trim() && pattern.test(value);

function validScope(scope: CircleScope): boolean {
  return (
    scope != null &&
    scope.endpoint === 'OpenSchool' &&
    matches(GUID, scope.circleId) &&
    matches(MODEL, scope.model)
  );
}

function sameKey(left: BindingKey, right: BindingKey): boolean {
  return (
    left != null &&
    left.chatOwnerId === right.chatOwnerId &&
    left.conversationId === right.conversationId
  );
}

function prepare(facts: AdmissionFacts): PreparedFacts | AdmissionDenial {
  const actor = facts?.actor;
  const conversation = facts?.conversation;
  if (
    !actor ||
    !matches(OWNER, actor.chatOwnerId) ||
    !matches(GUID, actor.memberId) ||
    !conversation ||
    typeof conversation !== 'object' ||
    !('finalId' in conversation) ||
    !matches(GUID, conversation.finalId?.value) ||
    !matches(OWNER, conversation.chatOwnerId)
  ) {
    return deny('invalid-facts');
  }
  if (actor.chatOwnerId !== conversation.chatOwnerId) {
    return deny('owner-mismatch');
  }
  if (conversation.kind === 'fresh-interactive') {
    if (
      conversation.origin !== 'interactive' ||
      conversation.finalId.source !== 'server-generated'
    ) {
      return deny('invalid-facts');
    }
  } else if (conversation.kind === 'existing-unbound') {
    if (
      conversation.finalId.source !== 'persisted' ||
      !['interactive', 'import', 'fork', 'duplicate'].includes(conversation.origin)
    ) {
      return deny('invalid-facts');
    }
  } else if (
    conversation.kind !== 'bound' ||
    conversation.origin !== 'interactive' ||
    conversation.finalId.source !== 'persisted'
  ) {
    return deny('invalid-facts');
  }
  if (facts.scope?.kind !== 'resolved' || !validScope(facts.scope.value)) {
    return deny('scope-unavailable');
  }
  /** Snapshot primitives before any await; neither the caller nor an adapter may change admission. */
  const binding: CircleBinding = Object.freeze({
    version: 1,
    key: Object.freeze({
      chatOwnerId: actor.chatOwnerId,
      conversationId: conversation.finalId.value,
    }),
    memberId: actor.memberId,
    scope: Object.freeze({
      endpoint: facts.scope.value.endpoint,
      circleId: facts.scope.value.circleId,
      model: facts.scope.value.model,
    }),
  });
  return { kind: conversation.kind, binding };
}

function decide(prepared: PreparedFacts, stored: BindingRead): AdmissionDecision {
  const expected = prepared.binding;
  if (stored?.kind === 'tombstone') {
    return deny(sameKey(stored.key, expected.key) ? 'tombstoned' : 'binding-mismatch');
  }
  if (stored?.kind === 'bound') {
    const actual = stored.binding;
    if (
      actual?.version !== 1 ||
      !sameKey(actual.key, expected.key) ||
      actual.memberId !== expected.memberId ||
      !validScope(actual.scope)
    ) {
      return deny('binding-mismatch');
    }
    if (
      actual.scope.endpoint !== expected.scope.endpoint ||
      actual.scope.circleId !== expected.scope.circleId ||
      actual.scope.model !== expected.scope.model
    ) {
      return deny('scope-mismatch');
    }
    if (prepared.kind === 'existing-unbound') {
      return deny('facts-conflict');
    }
    return { kind: 'admitted', binding: expected };
  }
  if (stored?.kind !== 'absent') {
    return deny('storage-unavailable');
  }
  if (prepared.kind === 'bound') {
    return deny('facts-conflict');
  }
  if (prepared.kind === 'existing-unbound') {
    return { kind: 'unbound' };
  }
  return { kind: 'insert-if-absent', binding: expected };
}

/** Pure decision: a proposed insert is NOT admission. No browser/project inference occurs here. */
export function evaluateConversationAdmission(
  facts: AdmissionFacts,
  stored: BindingRead,
): AdmissionDecision {
  const prepared = prepare(facts);
  return prepared.kind === 'denied' ? prepared : decide(prepared, stored);
}

/**
 * Bounded adapter runner: at most two reads and one atomic insert, no retries or external clients.
 * Fresh facts must attest that the final ID has no existing conversation/messages and is owned
 * by this interactive creation, including under concurrent import/create. No historical backfill.
 * Admission is a point-in-time result, not a lease against later revocation/deletion; integrating
 * callers must fence execution and reauthorize each request. No runtime is wired by this helper.
 */
export async function admitConversation(
  facts: AdmissionFacts,
  store: BindingStore,
): Promise<AdmissionResult> {
  const prepared = prepare(facts);
  if (prepared.kind === 'denied') {
    return prepared;
  }
  try {
    const decision = decide(prepared, await store.read(prepared.binding.key));
    if (decision.kind !== 'insert-if-absent') {
      return decision;
    }
    await store.insertIfAbsent(decision.binding);
    const confirmed = decide(prepared, await store.read(prepared.binding.key));
    return confirmed.kind === 'insert-if-absent' ? deny('storage-unavailable') : confirmed;
  } catch {
    return deny('storage-unavailable');
  }
}
