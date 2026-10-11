import { v5 as uuidv5 } from 'uuid';
import { randomUUID } from 'node:crypto';
import type { BindingKey, MongoBindingStore } from '@librechat/data-schemas';
import type { AdmissionFacts } from './admission';
import { admitConversation } from './admission';

const GUID =
  /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const NAMESPACE = 'd7f2518c-94b8-4fe8-97ad-2d4bdb2c9f43';
type RequestBody = Record<string, unknown> & {
  endpoint?: string;
  model?: string;
  endpointOption?: { endpoint?: string; model_parameters?: { model?: string } };
  arg?: { conversationId?: unknown };
};
type Request = {
  user?: { id?: string; memberId?: string; tenantId?: string };
  body?: RequestBody;
  path?: string;
  params?: Record<string, string>;
  _isScheduledFire?: boolean;
};
type Response = {
  statusCode?: number;
  status(code: number): Response;
  json(body: unknown): unknown;
  once(event: string, callback: () => void): unknown;
};
interface Dependencies {
  enabled: boolean;
  enforceExisting?: boolean;
  tenantId?: string;
  store(): MongoBindingStore;
  presence(key: BindingKey, conversationOnly?: boolean): Promise<'absent' | 'owned' | 'foreign'>;
  scope(user: Request['user'], model: string): Promise<AdmissionFacts['scope']>;
  report(error: unknown): void;
}
interface Execution {
  id: string;
  endpoint: string;
  model: string;
  key: BindingKey;
  operation?: string;
  entered: boolean;
  background: boolean;
  uncertain?: boolean;
}
const admissionMessages: Readonly<Record<string, string>> = {
  OPENSCHOOL_SCOPE_MISMATCH: '請另開新對話',
  OPENSCHOOL_CONVERSATION_DELETED: '這段對話已刪除或正在刪除，請另開新對話。',
  OPENSCHOOL_DELETION_PENDING: '對話仍有作業尚未確認結束，暫時無法完成刪除，請稍後再試。',
};
class AdmissionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(admissionMessages[code] ?? '目前無法確認對話的使用資格，請稍後再試。');
  }
}

export interface CircleExecution {
  beforeOptions(
    req: Request,
    res: Response,
    selected: { endpoint: string; model: string },
    next: () => Promise<unknown>,
  ): Promise<unknown>;
  wrap<Args extends unknown[]>(
    controller: (req: Request, res: Response, ...args: Args) => Promise<unknown>,
  ): (req: Request, res: Response, ...args: Args) => Promise<unknown>;
  finalId(req: Request, fallback: string): string;
  assertId(req: Request | undefined, id: string): void;
  background(req: Request): void;
  settle(req: Request, writes: Promise<unknown>[]): Promise<void>;
  complete(req: Request, writes: Promise<unknown>[], cleanup: () => Promise<void>): Promise<void>;
  release(req: Request): Promise<void>;
  retire(owner: string, ids: string[]): Promise<void>;
  drained(owner: string, ids: string[]): Promise<void>;
  retireOwner(owner: string): Promise<string[]>;
  fence(owner: string, ids: string[], drain: () => Promise<void>): Promise<void>;
  validateUpdate(req: Request, res: Response, next: () => unknown): unknown;
  existingResponse(res: Response, value: unknown): unknown;
  mutation(
    controller: (req: Request, res: Response) => Promise<unknown>,
    storedScope?: boolean,
  ): (req: Request, res: Response) => Promise<unknown>;
  importBatch(
    owner: string,
    tenantId: string | undefined,
    ids: string[],
    write: () => Promise<void>,
  ): Promise<void>;
  respond(res: Response, error: unknown): unknown;
  deletionError(res: Response & { send(body: string): unknown }, error: unknown): unknown;
}
export interface CircleExecutionOptions {
  enabled: boolean;
  enforceExisting: boolean;
  tenantId?: string;
  binding: {
    namespace: string;
    timeoutMS: number;
    topology: { mode: 'standalone' } | { mode: 'replica-set'; setName: string };
  };
}

/** Request identity is held outside browser data. Dependencies are trusted startup configuration. */
export function createCircleExecution(deps: Dependencies): CircleExecution {
  const guarding = deps.enabled || deps.enforceExisting === true;
  const executions = new WeakMap<Request, Execution>();
  function fail(code = 'OPENSCHOOL_ADMISSION_UNAVAILABLE', status = 503): never {
    throw new AdmissionError(status, code);
  }
  async function release(req: Request) {
    const state = executions.get(req);
    if (!state?.operation || state.uncertain) return;
    const operation = state.operation;
    try {
      await deps.store().release(state.key, operation);
    } catch {
      throw new Error('Circle execution release could not be confirmed');
    }
    state.operation = undefined;
  }
  async function prepare(req: Request, selected: { endpoint: string; model: string }) {
    if (!guarding || executions.has(req)) return;
    const body = req.body ?? {};
    const owner = req.user?.id ?? '';
    if (!/^[0-9a-f]{24}$/.test(owner) || (req.user?.tenantId ?? '') !== (deps.tenantId ?? ''))
      fail();
    const input = body.conversationId;
    const override =
      typeof body.overrideConvoId === 'string' ? body.overrideConvoId.split('__')[0] : undefined;
    const fresh =
      selected.endpoint === 'OpenSchool' &&
      !override &&
      (!input || input === 'new') &&
      req.path !== '/resume' &&
      !req._isScheduledFire;
    const requestId = body.clientRequestId;
    if (
      fresh &&
      requestId != null &&
      (typeof requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(requestId))
    ) {
      fail('INVALID_CLIENT_REQUEST_ID', 400);
    }
    let id = override ?? input;
    if (override === undefined && fresh) {
      id = requestId ? uuidv5(`${owner}:${requestId}`, NAMESPACE) : randomUUID();
    }
    // Historical non-UUID records cannot have a binding. They must actually exist.
    if (typeof id !== 'string' || !GUID.test(id)) {
      if (selected.endpoint === 'OpenSchool' && !req._isScheduledFire) {
        if (
          typeof id !== 'string' ||
          (await deps.presence({ chatOwnerId: owner, conversationId: id })) !== 'owned'
        ) {
          fail('OPENSCHOOL_UNKNOWN_CONVERSATION', 409);
        }
      }
      return;
    }
    const key = { chatOwnerId: owner, conversationId: id };
    const store = deps.store();
    if (override && input !== id && typeof input === 'string' && GUID.test(input)) {
      const source = await store.read({ chatOwnerId: owner, conversationId: input });
      if (source.kind !== 'absent' && source.kind !== 'unbound')
        fail('OPENSCHOOL_SCOPE_MISMATCH', 409);
    }
    const stored = await store.read(key);
    if (stored.kind === 'error' || stored.kind === 'unknown') fail();
    if (stored.kind === 'tombstone') fail('OPENSCHOOL_CONVERSATION_DELETED', 409);
    const state: Execution = { ...selected, id, key, entered: false, background: false };
    executions.set(req, state);
    if (stored.kind === 'unbound') {
      if (stored.pending || (await deps.presence(key, true)) !== 'owned') fail();
      return; // Existing import/fork stays unbound; never infers a circle from client fields.
    }
    if (stored.kind === 'absent') {
      const presence = await deps.presence(key);
      if (presence === 'foreign') fail('OPENSCHOOL_OWNER_MISMATCH', 403);
      if (!fresh && presence === 'absent' && !req._isScheduledFire)
        fail('OPENSCHOOL_UNKNOWN_CONVERSATION', 409);
      // Only a server allocated interactive ID with no persisted identity may acquire a binding.
      if (
        !deps.enabled ||
        !fresh ||
        presence === 'owned' ||
        selected.endpoint !== 'OpenSchool' ||
        selected.model === 'personal'
      )
        return;
    }
    if (selected.endpoint !== 'OpenSchool') fail('OPENSCHOOL_SCOPE_MISMATCH', 409);
    if (stored.kind === 'bound' && selected.model === 'personal')
      fail('OPENSCHOOL_SCOPE_MISMATCH', 409);
    const scope = await deps.scope(req.user, selected.model);
    const result = await admitConversation(
      {
        actor: { chatOwnerId: owner, memberId: req.user?.memberId ?? '' },
        conversation:
          stored.kind === 'bound'
            ? {
                kind: 'bound',
                origin: 'interactive',
                chatOwnerId: owner,
                finalId: { value: id, source: 'persisted' },
              }
            : {
                kind: 'fresh-interactive',
                origin: 'interactive',
                chatOwnerId: owner,
                finalId: { value: id, source: 'server-generated' },
              },
        scope,
      },
      store,
    );
    if (result.kind !== 'admitted') {
      fail(
        result.kind === 'denied' && result.reason === 'scope-mismatch'
          ? 'OPENSCHOOL_SCOPE_MISMATCH'
          : undefined,
        result.kind === 'denied' && result.reason === 'scope-mismatch' ? 409 : 503,
      );
    }
    const operation = randomUUID();
    // If the write outcome is uncertain, leave the durable occupancy for explicit reconciliation.
    if (!(await store.acquire(result.binding, operation)))
      fail('OPENSCHOOL_CONVERSATION_DELETED', 409);
    state.operation = operation;
  }
  function respond(res: Response, error: unknown) {
    const known = error instanceof AdmissionError;
    if (!known) deps.report(error);
    return res.status(known ? error.status : 503).json({
      code: known ? error.code : 'OPENSCHOOL_ADMISSION_UNAVAILABLE',
      error: known ? error.message : '目前無法確認對話的使用資格，請稍後再試。',
    });
  }
  function deletionError(res: Response & { send(body: string): unknown }, error: unknown) {
    if (!guarding && !(error instanceof AdmissionError)) {
      res.status(500);
      return res.send('Error clearing conversations');
    }
    return respond(res, error);
  }
  async function beforeOptions(
    req: Request,
    res: Response,
    selected: { endpoint: string; model: string },
    next: () => Promise<unknown>,
  ) {
    if (!guarding) return next();
    try {
      await prepare(req, selected);
      res.once('finish', () => {
        if (!executions.get(req)?.entered) void release(req).catch(deps.report);
      });
    } catch (error) {
      return respond(res, error);
    }
    return next();
  }
  function wrap<Args extends unknown[]>(
    controller: (req: Request, res: Response, ...args: Args) => Promise<unknown>,
  ) {
    return async (req: Request, res: Response, ...args: Args) => {
      try {
        if (guarding && !executions.has(req)) {
          await prepare(req, {
            endpoint: req.body?.endpoint ?? '',
            model: req.body?.endpointOption?.model_parameters?.model ?? req.body?.model ?? '',
          });
        }
        const state = executions.get(req);
        if (state) {
          if (
            state.operation &&
            (req.body?.endpointOption?.endpoint !== state.endpoint ||
              req.body?.endpointOption?.model_parameters?.model !== state.model)
          ) {
            fail('OPENSCHOOL_SCOPE_MISMATCH', 409);
          }
          state.entered = true;
        }
      } catch (error) {
        return respond(res, error);
      }
      try {
        return await controller(req, res, ...args);
      } catch (error) {
        const state = executions.get(req);
        if (state) state.uncertain = true;
        throw error;
      } finally {
        if (!executions.get(req)?.background && (res.statusCode ?? 200) < 500)
          await release(req).catch(deps.report);
      }
    };
  }
  function finalId(req: Request, fallback: string) {
    return executions.get(req)?.id ?? fallback;
  }
  function assertId(req: Request | undefined, id: string) {
    const state = req && executions.get(req);
    if (state && state.id !== id) fail('OPENSCHOOL_SCOPE_MISMATCH', 409);
  }
  function background(req: Request) {
    const state = executions.get(req);
    if (state) state.background = true;
  }
  async function settle(req: Request, writes: Promise<unknown>[]) {
    const results = await Promise.allSettled(writes);
    const state = executions.get(req);
    if (state && results.some((result) => result.status === 'rejected')) {
      state.uncertain = true;
      deps.report(new Error('Circle execution persistence could not be confirmed'));
    }
  }
  async function complete(req: Request, writes: Promise<unknown>[], cleanup: () => Promise<void>) {
    await settle(req, writes);
    try {
      await cleanup();
    } finally {
      await release(req);
    }
  }
  async function retire(owner: string, ids: string[]) {
    if (!guarding) return;
    for (const id of ids) {
      if (GUID.test(id)) await deps.store().tombstone({ chatOwnerId: owner, conversationId: id });
    }
  }
  async function drained(owner: string, ids: string[]) {
    if (!guarding) return;
    // A failed delete is retryable. Never expire/steal a possibly live provider execution.
    for (const id of ids) {
      if (GUID.test(id) && !(await deps.store().idle({ chatOwnerId: owner, conversationId: id }))) {
        fail('OPENSCHOOL_DELETION_PENDING', 409);
      }
    }
  }
  async function retireOwner(owner: string): Promise<string[]> {
    if (!guarding) return [];
    const ids = (await deps.store().ownerKeys(owner)).map((key) => key.conversationId);
    await retire(owner, ids);
    return ids;
  }
  async function fence(owner: string, ids: string[], drain: () => Promise<void>) {
    if (!guarding) return;
    await drain();
    await drained(owner, ids);
  }
  async function importBatch(
    owner: string,
    tenantId: string | undefined,
    ids: string[],
    write: () => Promise<void>,
  ): Promise<void> {
    if (!guarding) return write();
    if ((tenantId ?? '') !== (deps.tenantId ?? '') || new Set(ids).size !== ids.length) fail();
    const store = deps.store();
    const operation = randomUUID();
    const keys = ids.map((conversationId) => ({ chatOwnerId: owner, conversationId }));
    // Any failure retains reservations. Never release a possibly active/ambiguous writer.
    for (const key of keys) {
      if ((await deps.presence(key)) !== 'absent' || !(await store.reserveImport(key, operation)))
        fail('OPENSCHOOL_IMPORT_COLLISION', 409);
    }
    await write();
    for (const key of keys) await store.release(key, operation);
  }
  function validateUpdate(req: Request, res: Response, next: () => unknown) {
    const id = req.body?.arg?.conversationId;
    if (
      typeof id !== 'string' ||
      !id ||
      id === 'new' ||
      (req.body?.conversationId != null && req.body.conversationId !== id)
    ) {
      return res.status(400).json({ error: 'Invalid conversationId' });
    }
    return next();
  }
  function existingResponse(res: Response, value: unknown) {
    return value == null
      ? res.status(404).json({ error: 'Conversation not found' })
      : res.status(201).json(value);
  }
  function mutation(
    controller: (req: Request, res: Response) => Promise<unknown>,
    storedScope = false,
  ) {
    return async (req: Request, res: Response) => {
      if (!guarding) return controller(req, res);
      const id = req.params?.conversationId ?? req.body?.arg?.conversationId ?? '';
      if (typeof id !== 'string')
        return respond(res, new AdmissionError(400, 'OPENSCHOOL_ID_MISMATCH'));
      const key = { chatOwnerId: req.user?.id ?? '', conversationId: id };
      const admitted = { ...req, body: { ...req.body, conversationId: id } as RequestBody };
      try {
        if (req.body?.conversationId != null && req.body.conversationId !== id)
          fail('OPENSCHOOL_ID_MISMATCH', 400);
        if ((await deps.presence(key, true)) !== 'owned')
          fail('OPENSCHOOL_CONVERSATION_NOT_FOUND', 404);
        const stored = GUID.test(id) ? await deps.store().read(key) : { kind: 'absent' as const };
        const endpoint =
          (!storedScope && req.body?.endpoint) ||
          (stored.kind === 'bound' ? stored.binding.scope.endpoint : '');
        const model =
          (!storedScope && req.body?.model) ||
          (stored.kind === 'bound' ? stored.binding.scope.model : '');
        // Only the route's destination is relevant; body override IDs have no write authority.
        delete admitted.body.overrideConvoId;
        await prepare(admitted, { endpoint, model });
      } catch (error) {
        return respond(res, error);
      }
      try {
        return await controller(req, res);
      } catch (error) {
        const state = executions.get(admitted);
        if (state) state.uncertain = true;
        throw error;
      } finally {
        if ((res.statusCode ?? 200) < 500) await release(admitted).catch(deps.report);
      }
    };
  }
  return {
    importBatch,
    deletionError,
    respond,
    beforeOptions,
    wrap,
    finalId,
    assertId,
    background,
    settle,
    complete,
    release,
    retire,
    drained,
    retireOwner,
    fence,
    validateUpdate,
    existingResponse,
    mutation,
  };
}

/** Deployment identity/topology are server-only, alongside the metadata namespace and credentials.
 * Intentionally not a browser-visible configuration field; no automatic topology fallback. */
export function circleExecutionOptions(
  env: Record<string, string | undefined>,
): CircleExecutionOptions {
  const enabled = env.OPENSCHOOL_CIRCLE_ADMISSION_ENABLED === 'true';
  const mode = env.OPENSCHOOL_BINDING_TOPOLOGY;
  return {
    enabled,
    enforceExisting: Boolean(env.OPENSCHOOL_METADATA_NAMESPACE),
    tenantId: env.OPENSCHOOL_METADATA_TENANT_ID,
    binding: {
      namespace: env.OPENSCHOOL_METADATA_NAMESPACE ?? '',
      timeoutMS: 3000,
      topology:
        mode === 'replica-set'
          ? { mode: 'replica-set' as const, setName: env.OPENSCHOOL_BINDING_REPLICA_SET ?? '' }
          : { mode: mode as 'standalone' },
    },
  };
}
