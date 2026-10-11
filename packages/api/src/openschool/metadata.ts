import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Router, json } from 'express';
import type { ErrorRequestHandler } from 'express';
import type {
  MetadataQuery,
  MetadataScope,
  MetadataPosition,
  ConversationMetadata,
} from '@librechat/data-schemas';

const audience = 'openschool-chat-metadata-v1';
const sort = 'updatedAt:desc,id:asc';
const guid =
  /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ownerId = /^[0-9a-f]{24}$/;
const failure = (status: number): Error & { status: number } =>
  Object.assign(new Error('Metadata unavailable'), { status });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (pattern: RegExp, value: unknown): value is string =>
  typeof value === 'string' && value === value.trim() && pattern.test(value);
const validKey = (value: unknown): value is string =>
  typeof value === 'string' && value === value.trim() && /^[\x21-\x7e]{32,256}$/.test(value);
const validDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export interface MetadataDependencies {
  /** Explicit true + dedicated key + binding namespace required. No enable/config defaults. */
  env: Readonly<Record<string, string | undefined>>;
  /** Must use the existing fixed CentralTrustProfile.validate, never an input URL. */
  resolveProfile: () => { api: string };
  fetchImpl: typeof fetch;
  query: MetadataQuery;
  now?: () => number;
}

export interface ConversationMetadataCandidate extends MetadataScope {
  version: 1;
  range: 'all' | '7d';
  since: string | null;
  items: Array<ConversationMetadata & { circle: string; owner: string }>;
  nextCursor: string | null;
}

function scopeFrom(value: unknown, now: number): MetadataScope {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.audience !== audience ||
    !matches(guid, value.actor) ||
    !matches(guid, value.member) ||
    !matches(guid, value.circle) ||
    !matches(ownerId, value.owner) ||
    (value.view !== 'mine' && value.view !== 'manager' && value.view !== 'manager-preview') ||
    ((value.view === 'mine' || value.view === 'manager-preview') && value.actor !== value.member) ||
    !(value.range === undefined || value.range === 'all'
      ? value.since === undefined || value.since === null
      : value.range === '7d' &&
        validDate(value.since) &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.since) &&
        Date.parse(value.since) <= now)
  ) {
    throw failure(503);
  }
  return {
    actor: value.actor,
    member: value.member,
    circle: value.circle,
    owner: value.owner,
    view: value.view,
    range: value.range === '7d' ? '7d' : 'all',
    since: typeof value.since === 'string' ? value.since : null,
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      'application/json' ||
    Number(response.headers.get('content-length')) > 8192 ||
    !response.body
  ) {
    await response.body?.cancel();
    throw failure(503);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      size += part.value.byteLength;
      if (size > 8192) {
        throw failure(503);
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel();
  }
}

function cursorCodec(key: string, namespace: string, now: () => number) {
  const secret = createHash('sha256').update(`${audience}:cursor\0${key}`).digest();
  const context = (scope: MetadataScope) => JSON.stringify({ ...scope, namespace, sort });
  return {
    encode(scope: MetadataScope, position: MetadataPosition): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secret, iv);
      cipher.setAAD(Buffer.from(context(scope)));
      const data = Buffer.from(JSON.stringify({ version: 1, position, expires: now() + 300000 }));
      const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    },
    decode(scope: MetadataScope, token: string): MetadataPosition {
      try {
        if (!/^[A-Za-z0-9_-]{40,2048}$/.test(token)) {
          throw failure(400);
        }
        const bytes = Buffer.from(token, 'base64url');
        if (bytes.toString('base64url') !== token) {
          throw failure(400);
        }
        const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
        decipher.setAAD(Buffer.from(context(scope)));
        decipher.setAuthTag(bytes.subarray(12, 28));
        const payload: unknown = JSON.parse(
          Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
        );
        if (
          !isRecord(payload) ||
          payload.version !== 1 ||
          typeof payload.expires !== 'number' ||
          payload.expires <= now() ||
          payload.expires > now() + 300000 ||
          !isRecord(payload.position) ||
          !matches(guid, payload.position.id) ||
          !validDate(payload.position.updatedAt)
        ) {
          throw failure(400);
        }
        return { id: payload.position.id, updatedAt: payload.position.updatedAt };
      } catch {
        throw failure(400);
      }
    },
  };
}

function validRows(rows: ConversationMetadata[], scope: MetadataScope): boolean {
  return (
    Array.isArray(rows) &&
    rows.length <= 51 &&
    rows.every(
      (row, i) =>
        isRecord(row) &&
        matches(guid, row.id) &&
        typeof row.title === 'string' &&
        row.title.length <= 256 &&
        validDate(row.createdAt) &&
        validDate(row.updatedAt) &&
        row.updatedAt >= row.createdAt &&
        (scope.range !== '7d' || row.updatedAt >= scope.since!) &&
        Number.isSafeInteger(row.savedUserTurns) &&
        row.savedUserTurns >= 0 &&
        (i === 0 ||
          rows[i - 1].updatedAt > row.updatedAt ||
          (rows[i - 1].updatedAt === row.updatedAt && rows[i - 1].id < row.id)),
    )
  );
}

/** Protocol limits are fixed here per the v1 contract, not caller-controlled request options. */
export function createConversationMetadataService(
  deps: MetadataDependencies,
): (body: unknown) => Promise<ConversationMetadataCandidate> {
  const {
    OPENSCHOOL_METADATA_KEY: key,
    OPENSCHOOL_METADATA_NAMESPACE: namespace,
    OPENSCHOOL_CENTRAL_API_KEY: centralKey,
  } = deps.env;
  const now = deps.now ?? Date.now;
  return async (body) => {
    if (
      !validKey(key) ||
      !validKey(centralKey) ||
      !namespace ||
      namespace.trim() !== namespace ||
      namespace.length > 200 ||
      deps.env.OPENSCHOOL_METADATA_ENABLED !== 'true' ||
      deps.env.OPENSCHOOL_CIRCLE_ADMISSION_ENABLED !== 'true'
    ) {
      throw failure(503);
    }
    if (
      !isRecord(body) ||
      Object.keys(body).some((k) => k !== 'grant' && k !== 'cursor') ||
      typeof body.grant !== 'string' ||
      !body.grant.trim() ||
      body.grant.length > 4096 ||
      ('cursor' in body &&
        (typeof body.cursor !== 'string' || body.cursor.length === 0 || body.cursor.length > 2048))
    ) {
      throw failure(400);
    }
    let scope: MetadataScope;
    try {
      const profile = deps.resolveProfile();
      const response = await deps.fetchImpl(
        `${profile.api}/internal/central-sso/metadata/resolve`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json', 'X-OpenSchool-Central-Key': centralKey },
          body: JSON.stringify({ grant: body.grant }),
        },
      );
      if (response.status !== 200 || response.redirected) {
        await response.body?.cancel();
        throw failure(response.status === 401 || response.status === 403 ? response.status : 503);
      }
      scope = scopeFrom(await boundedJson(response), now());
    } catch (error) {
      if (isRecord(error) && (error.status === 401 || error.status === 403)) {
        throw error;
      }
      throw failure(503);
    }
    const codec = cursorCodec(key, namespace, now);
    const after = typeof body.cursor === 'string' ? codec.decode(scope, body.cursor) : undefined;
    let rows: ConversationMetadata[];
    try {
      rows = await deps.query(scope, after);
      if (!validRows(rows, scope)) {
        throw failure(503);
      }
    } catch {
      throw failure(503);
    }
    const page = rows.slice(0, 50);
    const items = page.map((row) => ({
      id: row.id,
      circle: scope.circle,
      owner: scope.owner,
      title: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      savedUserTurns: row.savedUserTurns,
    }));
    return {
      version: 1,
      ...scope,
      range: scope.range ?? 'all',
      since: scope.since ?? null,
      items,
      nextCursor:
        rows.length > 50
          ? codec.encode(scope, { id: items[49].id, updatedAt: items[49].updatedAt })
          : null,
    };
  };
}

/** Mount before general body parsers/cookie/auth middleware. No browser identity is consumed. */
export function createConversationMetadataRouter(deps: MetadataDependencies): Router {
  const router = Router();
  const env = { ...deps.env };
  const service = createConversationMetadataService({ ...deps, env });
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (env.OPENSCHOOL_METADATA_ENABLED !== 'true') {
      res.sendStatus(404);
      return;
    }
    const key = env.OPENSCHOOL_METADATA_KEY;
    if (!validKey(key) || env.OPENSCHOOL_CIRCLE_ADMISSION_ENABLED !== 'true') {
      res.sendStatus(503);
      return;
    }
    const supplied = req.get('X-OpenSchool-Metadata-Key');
    if (
      !validKey(supplied) ||
      !timingSafeEqual(
        createHash('sha256').update(key).digest(),
        createHash('sha256').update(supplied).digest(),
      )
    ) {
      res.sendStatus(401);
      return;
    }
    next();
  });
  router.post(
    '/query',
    json({ limit: 8192, strict: true, inflate: false }),
    async (req, res, next) => {
      try {
        if (!req.is('application/json') || Object.keys(req.query).length !== 0) {
          throw failure(400);
        }
        const result = await service(req.body);
        // Remains JSON text, including hostile titles; never render HTML or echo upstream errors.
        res
          .type('application/json')
          .send(
            JSON.stringify(result).replace(
              /[<>&]/g,
              (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
            ),
          );
      } catch (error) {
        next(error);
      }
    },
  );
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status =
      isRecord(error) && [400, 401, 403, 413, 415, 503].includes(Number(error.status))
        ? Number(error.status)
        : 503;
    res.sendStatus(status);
  };
  router.use(errors);
  router.use((_req, res) => {
    res.sendStatus(404);
  });
  return router;
}
