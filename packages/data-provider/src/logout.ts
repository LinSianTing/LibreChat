const KEY = 'librechat.central.logout.pending';
let retainedToken: string | undefined;

/** Retained only for retrying revocation, never restored as an authenticated session. */
export function getPendingLogoutToken(): string | undefined {
  try {
    return retainedToken ?? sessionStorage.getItem(KEY) ?? undefined;
  } catch {
    return retainedToken;
  }
}

export function setPendingLogoutToken(token: string | undefined): void {
  retainedToken = token;
  try {
    if (token) {
      sessionStorage.setItem(KEY, token);
    } else {
      sessionStorage.removeItem(KEY);
    }
  } catch {
    // Keep the in-memory retry credential if browser storage is unavailable.
  }
}

/** UI routing hint only. The server always verifies the signature and binding. */
export function isCentralSessionToken(token: string | undefined): boolean {
  try {
    const part = token?.split('.')[1];
    if (!part) {
      return false;
    }
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload?.centralSession?.reference === 'string';
  } catch {
    return false;
  }
}
