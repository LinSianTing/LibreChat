const ATTEMPT_KEY = 'openschool.central-entry-attempted.v1';

/** Only conversation destinations, never auth/recovery endpoints or external URLs. */
export function isCentralEntryTarget(target: unknown): target is string {
  return (
    typeof target === 'string' &&
    // eslint-disable-next-line no-control-regex -- Reject control characters in navigation input.
    !/[\\\u0000-\u001f\u007f]/.test(target) &&
    /^\/c\/(?:new|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\?[^#]*)?$/i.test(target)
  );
}

export async function attemptCentralEntry(options: {
  blocked: boolean;
  target: unknown;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  persist: (target: string) => void;
  request: () => Promise<boolean>;
  isCurrent: () => boolean;
  navigate: () => void;
}): Promise<void> {
  const { blocked, target, storage, persist, request, isCurrent, navigate } = options;
  try {
    if (blocked) {
      storage.setItem(ATTEMPT_KEY, '1');
      return;
    }
    if (!isCentralEntryTarget(target) || storage.getItem(ATTEMPT_KEY)) return;
    // Written before async work: refresh/back/StrictMode cannot issue a second attempt.
    // Never clear on errors, logout or successful login; this is first-entry-only.
    storage.setItem(ATTEMPT_KEY, '1');
    persist(target);
    if ((await request()) && isCurrent()) navigate();
  } catch {
    // Storage/network failures retain the existing manual sign-in/recovery UI.
  }
}
