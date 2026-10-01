export const HANDOFF_KEY = 'openschool.prompt-handoff';
export const HANDOFF_TTL = 10 * 60 * 1000;
export const HANDOFF_ID = /^[a-f0-9]{64}$/;
export const HANDOFF_MODEL = /^(personal|circle-[a-z0-9-]{1,64})$/;
export type PendingHandoff = { id: string; expiresAt: number };
export type HandoffDraft = { prompt: string; model: string; expiresAtUtc: string };
export type HandoffCapture = { pending?: PendingHandoff; error?: 'expired' | 'invalid' };

/** Refresh may omit id; GET user adds it. Every supplied ID must agree exactly. */
export function handoffUserId(user: unknown): string | undefined {
  if (user == null || typeof user !== 'object' || Array.isArray(user)) {
    return undefined;
  }
  let owner: string | undefined;
  for (const key of ['id', '_id']) {
    if (!Object.hasOwn(user, key)) {
      continue;
    }
    const value = (user as Record<string, unknown>)[key];
    if (
      typeof value !== 'string' ||
      !value ||
      value.trim() !== value ||
      (owner !== undefined && owner !== value)
    ) {
      return undefined;
    }
    owner = value;
  }
  return owner;
}

export function clearHandoff(): void {
  try {
    sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    /* Storage can be unavailable; an already signed-in handoff still works. */
  }
}

export function readHandoff(): HandoffCapture {
  try {
    const value = sessionStorage.getItem(HANDOFF_KEY);
    if (!value) {
      return {};
    }
    const saved: PendingHandoff = JSON.parse(value);
    if (!HANDOFF_ID.test(saved.id) || !Number.isFinite(saved.expiresAt)) {
      return { error: 'invalid' };
    }
    if (saved.expiresAt <= Date.now() || saved.expiresAt > Date.now() + HANDOFF_TTL) {
      return { pending: { id: saved.id, expiresAt: saved.expiresAt }, error: 'expired' };
    }
    return { pending: { id: saved.id, expiresAt: saved.expiresAt } };
  } catch {
    return { error: 'invalid' };
  }
}

/** Only these two fields survive an OAuth navigation. The Web remains the TTL/owner authority. */
export function captureHandoff(params: URLSearchParams): HandoffCapture {
  const stored = readHandoff();
  if (!params.has('os_handoff')) {
    return stored;
  }
  const id = params.get('os_handoff') ?? '';
  if (
    params.getAll('os_handoff').length !== 1 ||
    !HANDOFF_ID.test(id) ||
    params.get('endpoint') !== 'OpenSchool' ||
    !HANDOFF_MODEL.test(params.get('model') ?? '')
  ) {
    clearHandoff();
    return { error: 'invalid' };
  }
  if (stored.pending?.id === id) {
    return stored;
  }
  const pending = { id, expiresAt: Date.now() + HANDOFF_TTL };
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(pending));
  } catch {
    return { error: 'invalid' };
  }
  return { pending };
}

export function hasHandoff(): boolean {
  try {
    return sessionStorage.getItem(HANDOFF_KEY) != null;
  } catch {
    return false;
  }
}

export function safeHandoffParams(params: URLSearchParams): URLSearchParams {
  const safe = new URLSearchParams();
  for (const key of ['endpoint', 'model', 'os_handoff']) {
    const value = params.get(key);
    if (value != null) {
      safe.set(key, value);
    }
  }
  return safe;
}
