import { LocalStorageKeys } from 'librechat-data-provider';

const MARKER = 'openschool.central.draft-scope';
const PREFIX = 'openschool-central-draft:';
let scope: string | undefined;
let writable = true;

export function centralReference(token?: string): string | undefined {
  try {
    const payload = JSON.parse(
      atob((token ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/')),
    );
    const reference = payload.centralSession?.reference;
    return typeof reference === 'string' && /^[0-9a-f-]{36}$/i.test(reference)
      ? reference
      : undefined;
  } catch {
    return undefined;
  }
}

// This is a storage namespace, never an authorization decision. The server verifies the JWT.
export function activateCentralDraftScope(token?: string): boolean {
  const next = centralReference(token);
  if (next == null) return true;
  let previous = scope;
  try {
    previous ??= sessionStorage.getItem(MARKER) ?? undefined;
  } catch {
    /* memory only */
  }
  if (previous && previous !== next) {
    scope = previous;
    clearCentralDrafts();
    return false; // Reload the document rather than adopt B into A's in-memory UI.
  }
  if (scope !== next) {
    scope = next;
    writable = false;
  }
  try {
    sessionStorage.setItem(MARKER, next);
  } catch {
    /* memory only */
  }
  return true;
}

export function lockCentralDrafts() {
  if (scope) writable = false;
}
export function unlockCentralDrafts() {
  writable = true;
}
export function centralDraftsWritable() {
  return !scope || writable;
}
export function scopedDraftKey(key: string): string {
  return scope ? `${PREFIX}${scope}:${key}` : key;
}
export function unscopedDraftKey(key: string): string | undefined {
  if (!scope) return key.startsWith(PREFIX) ? undefined : key;
  const prefix = `${PREFIX}${scope}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}
export function clearCentralDrafts(): boolean {
  if (!scope) return false;
  writable = false;
  try {
    for (const key of Object.keys(localStorage)) {
      const logical = unscopedDraftKey(key);
      if (
        logical?.startsWith(LocalStorageKeys.TEXT_DRAFT) ||
        logical?.startsWith(LocalStorageKeys.FILES_DRAFT)
      ) {
        localStorage.removeItem(key);
      }
    }
    sessionStorage.removeItem(MARKER);
  } catch {
    /* blocked storage remains inaccessible to the next scope */
  }
  return true;
}
