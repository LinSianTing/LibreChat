const crypto = require('node:crypto');
const cookies = require('cookie');

const trustProfiles = require('./CentralTrustProfile');
const RETENTION_MS = 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const opaque = () => crypto.randomBytes(32).toString('hex');
const fail = (status = 401) => Object.assign(new Error('Central logout unavailable'), { status });
const invoke = (session, method) =>
  new Promise((resolve, reject) => {
    if (typeof session?.[method] !== 'function') return reject(fail(503));
    session[method]((error) => (error ? reject(fail(503)) : resolve()));
  });

/** Logout-only data lives in the existing Express server-side store, never an auth JWT. */
function createCentralLogout({ assertConfig, binding, match, revoke, env }) {
  const profile = trustProfiles.select(env);
  const ROOT = `${profile.prefix}/api/auth/central-logout`;
  const CALLBACK = `${profile.origin}${ROOT}/callback`;
  const ISSUER = profile.issuer;
  const locks = new Map();
  const serialized = async (key, operation) => {
    const previous = locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    locks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(key) === current) locks.delete(key);
    }
  };
  const saveLogoutBinding = async (req, localSessionId, central, idToken) => {
    if (typeof idToken !== 'string' || !idToken || !/^[a-f0-9]{24}$/.test(localSessionId)) {
      throw fail();
    }
    // Called only after Passport verified the callback. A new login cannot inherit A's state.
    await invoke(req.session, 'regenerate');
    req.session.centralLogout = {
      localSessionId,
      central: binding(central),
      idToken,
      browserSessionId: req.sessionID,
      generation: opaque(),
      formState: opaque(),
      retainUntil: Date.now() + RETENTION_MS,
    };
    req.session.cookie.maxAge = RETENTION_MS; // logout recovery retention, NOT authentication expiry
    await invoke(req.session, 'save');
  };
  const record = (req) => {
    const value = req.session?.centralLogout;
    if (
      !value ||
      value.browserSessionId !== req.sessionID ||
      !Number.isFinite(value.retainUntil) ||
      value.retainUntil <= Date.now() ||
      !/^[a-f0-9]{64}$/.test(value.generation ?? '') ||
      !/^[a-f0-9]{64}$/.test(value.formState ?? '') ||
      !/^[a-f0-9]{24}$/.test(value.localSessionId ?? '') ||
      typeof value.idToken !== 'string' ||
      !value.idToken
    )
      throw fail();
    binding(value.central, { allowExpired: true });
    return value;
  };
  const verifyPayload = (token, secret, verifyToken) => {
    let payload;
    try {
      payload = verifyToken(token, secret, { algorithms: ['HS256'], ignoreExpiration: true });
    } catch {
      throw fail();
    }
    const central = binding(payload?.centralSession, { allowExpired: true });
    if (
      payload.id !== central.chatOwnerId ||
      !/^[a-f0-9]{24}$/.test(payload.sessionId ?? '') ||
      typeof payload.sessionId !== 'string' ||
      !Number.isFinite(payload.exp)
    )
      throw fail();
    return { localSessionId: payload.sessionId, central };
  };
  const same = (left, right) => {
    if (left.localSessionId !== right.localSessionId) throw fail();
    match(left.central, right.central);
  };
  const browserRecord = (req, verifyToken) => {
    const value = record(req);
    // An expired cookie is allowed ONLY as logout corroboration. Never live authorization.
    const refresh = cookies.parse(req.headers?.cookie ?? '').refreshToken;
    if (refresh) same(value, verifyPayload(refresh, env.JWT_REFRESH_SECRET, verifyToken));
    return value;
  };
  const headers = (res) =>
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; form-action 'self' ${ISSUER}/protocol/openid-connect/logout; frame-ancestors 'none'; base-uri 'none'`,
      'X-Content-Type-Options': 'nosniff',
    });
  const page = (res, status, message, state) => {
    headers(res);
    return res
      .status(status)
      .type('html')
      .send(
        `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>Central sign-out / 中央登出</title><main><h1>Central sign-out / 中央登出</h1><p>${message}</p>${state ? `<form method="post" action="${ROOT}/continue"><input type="hidden" name="state" value="${state}"><button type="submit">登出原工作階段／重試 · Sign out original session / Retry</button></form>` : ''}<p><a href="${ROOT}">返回登出恢復頁 · Sign-out recovery</a></p><p><a href="${profile.prefix}/login?redirect=false">返回登入頁（不自動登入） · Back to sign-in</a></p></main></html>`,
      );
  };
  const prepare = async (req, value, deleteSession) => {
    if (!value.pending || value.pending.expiresAt <= Date.now()) {
      value.pending = { state: opaque(), expiresAt: Date.now() + STATE_TTL_MS, issued: false };
      await invoke(req.session, 'save');
    }
    // Retry the idempotent revoke, even if a previous response was lost.
    try {
      await revoke(value.central.reference);
    } catch {
      throw fail(503);
    }
    await deleteSession({ sessionId: value.localSessionId });
    value.revoked = true;
    await invoke(req.session, 'save');
  };
  const logout = async (req, res, { verifyToken, deleteSession }) => {
    assertConfig();
    if (req.method !== 'POST' || req.baseUrl !== '/api/auth' || req.path !== '/logout')
      throw fail();
    const authorization = req.headers?.authorization;
    const bearer =
      typeof authorization === 'string'
        ? /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization)
        : null;
    if (!bearer) throw fail();
    const target = verifyPayload(bearer[1], env.JWT_SECRET, verifyToken);
    return serialized(req.sessionID, async () => {
      let current;
      try {
        await invoke(req.session, 'reload');
        current = browserRecord(req, verifyToken);
        same(target, current);
      } catch {
        current = null;
      }
      try {
        if (current) await prepare(req, current, deleteSession);
        else {
          try {
            await revoke(target.central.reference);
          } catch {
            throw fail(503);
          }
          await deleteSession({ sessionId: target.localSessionId });
        }
        req.session = null;
        headers(res);
        return res.status(200).send(
          current
            ? {
                message: 'Chat session revoked; identity-provider logout pending',
                redirect: ROOT,
              }
            : {
                code: 'CENTRAL_LOGOUT_BROWSER_MISMATCH',
                message:
                  'Original Chat session revoked. Current browser unchanged; IdP logout was not attempted.',
              },
        );
      } finally {
        // No cookie writes, implicit saves or touches on late A responses after B signs in.
        req.session = null;
      }
    });
  };
  const recovery = (deps) => async (req, res) => {
    if (String(env.OPENSCHOOL_CENTRAL_SSO).trim().toLowerCase() !== 'true')
      return res.sendStatus(404);
    const expected =
      req.method === 'GET'
        ? ['/central-logout', '/central-logout/callback']
        : ['/central-logout/continue'];
    if (!expected.includes(req.path)) return res.sendStatus(404);
    return serialized(req.sessionID, async () => {
      let value;
      try {
        assertConfig();
        await invoke(req.session, 'reload');
        value = browserRecord(req, deps.verifyToken);
        if (req.path === '/central-logout') {
          req.session = null;
          return page(
            res,
            200,
            '尚未確認中央 IdP 登出完成。若登入期限已過，請先登出原工作階段，再手動登入。Session expiry is unchanged; IdP sign-out is not yet confirmed.',
            value.formState,
          );
        }
        if (req.path === '/central-logout/continue') {
          if (typeof req.body?.state !== 'string' || req.body.state !== value.formState)
            throw fail();
          await prepare(req, value, deps.deleteSession);
          value.pending.issued = true;
          await invoke(req.session, 'save');
          const url = new URL(`${ISSUER}/protocol/openid-connect/logout`);
          url.searchParams.set('client_id', profile.client);
          url.searchParams.set('id_token_hint', value.idToken);
          url.searchParams.set('post_logout_redirect_uri', CALLBACK);
          url.searchParams.set('state', value.pending.state);
          req.session = null;
          headers(res);
          return res.redirect(303, url.toString());
        }
        if (
          !value.revoked ||
          !value.pending?.issued ||
          value.pending.expiresAt <= Date.now() ||
          typeof req.query.state !== 'string' ||
          req.query.state !== value.pending.state
        )
          throw fail();
        if (req.query.error !== undefined) {
          req.session = null;
          return page(
            res,
            502,
            'IdP 登出未完成；可重試。Identity-provider sign-out failed or was cancelled.',
            value.formState,
          );
        }
        // Destroy exactly the original Express session; never clear shared browser cookie names.
        await invoke(req.session, 'destroy');
        req.session = null;
        return page(
          res,
          200,
          '原 Chat 工作階段已撤銷，已收到對應的 IdP 返回。可手動重新登入。Original session revoked; matching IdP return received. Sign in explicitly when ready.',
        );
      } catch (error) {
        req.session = null;
        return page(
          res,
          error.status === 503 ? 503 : 401,
          '登出尚未完成或目前瀏覽器已換工作階段；未清除其他登入。Sign-out is incomplete or the browser session changed. No other session was cleared.',
          error.status === 503 && value ? value.formState : undefined,
        );
      } finally {
        req.session = null;
      }
    });
  };
  const loginFailure = (req, res) => {
    // No raw exception/token/IdP error reflected. This is not a successful silent SSO login.
    return page(
      res,
      401,
      '中央登入失敗；既有 IdP 工作階段可能已超過中央期限。請使用登出恢復頁結束原工作階段後，再手動登入。Central sign-in failed; the existing IdP session may have exceeded its central lifetime.',
    );
  };
  return { saveLogoutBinding, logout, logoutRecovery: recovery, centralLoginFailure: loginFailure };
}

module.exports = { createCentralLogout };
