/** A navigation convenience only. It never grants authentication or replaces OIDC validation. */
type EntrySession = {
  centralLogout?: unknown;
  centralEntryAttempted?: boolean;
  save(callback: (error?: unknown) => void): void;
  reload(callback: (error?: unknown) => void): void;
};
type EntryRequest = {
  session?: EntrySession;
  sessionID?: string;
  headers: { cookie?: string; authorization?: string };
};
type EntryResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): EntryResponse;
  json(value: { allowed: boolean }): unknown;
};

export function createCentralEntry({
  enabled,
}: {
  enabled: () => boolean;
}): (req: EntryRequest, res: EntryResponse) => Promise<unknown> {
  // The current deployment is one Chat process. This is not a distributed lock.
  const pending = new Set<string>();
  return async (req: EntryRequest, res: EntryResponse): Promise<unknown> => {
    res.setHeader('Cache-Control', 'no-store');
    const deny = (status = 409) => {
      // No response-time session touch/cookie write from a refused/stale A request.
      // In particular it must not overwrite a newer browser B session.
      req.session = undefined;
      return res.status(status).json({ allowed: false });
    };
    if (!enabled()) return deny(404);
    const id = req.sessionID;
    if (!id || !req.session || pending.has(id)) return deny();
    if (
      req.headers.authorization ||
      /(?:^|;\s*)(?:refreshToken|token_provider)=/.test(req.headers.cookie ?? '')
    ) {
      return deny();
    }
    pending.add(id);
    try {
      // A browser with any Express session cookie must reload successfully. Missing/
      // invalid/expired rows fail closed rather than being treated as a new browser.
      const existingBrowser = /(?:^|;\s*)connect\.sid=/.test(req.headers.cookie ?? '');
      if (existingBrowser) {
        await new Promise<void>((resolve, reject) => {
          req.session!.reload((error) => (error ? reject(error) : resolve()));
        });
      }
      if (!req.session) return deny();
      if (req.session.centralLogout !== undefined || req.session.centralEntryAttempted)
        return deny();
      if (existingBrowser) {
        req.session.centralEntryAttempted = true;
        await new Promise<void>((resolve, reject) => {
          req.session!.save((error) => (error ? reject(error) : resolve()));
        });
      }
      // A fresh browser's one-shot marker belongs to its tab, not a new cookie.
      // Neither success nor refusal may issue/touch cookies: a late A response
      // must not replace a concurrently established B login. OIDC owns its own state.
      req.session = undefined;
      return res.status(200).json({ allowed: true });
    } catch {
      return deny(503);
    } finally {
      pending.delete(id);
    }
  };
}
