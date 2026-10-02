const ISSUER = 'http://localhost:15480/realms/langrace-local';
const API_URL = 'http://localhost:15481';
const CLIENT_ID = 'chat-local';
const LOGOUT_REDIRECT = 'http://localhost:15483/';
const UUID =
  /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const OWNER = /^[0-9a-f]{24}$/;
const identityKeys = [
  'reference',
  'issuer',
  'clientId',
  'subject',
  'sid',
  'memberId',
  'chatOwnerId',
];
const identifier = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 255 &&
  value.trim() === value &&
  !/[\x00-\x1f\x7f]/.test(value);

function denied(status = 401) {
  const error = new Error('Central session is not authorized');
  error.status = status;
  return error;
}

/** Local-only server contract; callback grants cannot be reconstructed from request input. */
function createCentralSSO({ env = process.env, fetchImpl = (...args) => fetch(...args) } = {}) {
  const callbackGrants = new WeakMap();
  const enabled = () => String(env.OPENSCHOOL_CENTRAL_SSO).trim().toLowerCase() === 'true';
  const assertConfig = () => {
    if (
      !enabled() ||
      env.NODE_ENV !== 'development' ||
      env.OPENID_ISSUER !== ISSUER ||
      env.OPENID_CLIENT_ID !== CLIENT_ID ||
      env.OPENSCHOOL_CENTRAL_API_URL !== API_URL ||
      !env.OPENSCHOOL_CENTRAL_API_KEY?.trim() ||
      /^(true|1)$/i.test((env.OPENID_REUSE_TOKENS ?? '').trim())
    ) {
      throw denied(503);
    }
  };
  const binding = (value) => {
    if (
      !value ||
      !UUID.test(value.reference ?? '') ||
      !UUID.test(value.memberId ?? '') ||
      value.issuer !== ISSUER ||
      value.clientId !== CLIENT_ID ||
      !identifier(value.subject) ||
      !identifier(value.sid) ||
      !OWNER.test(value.chatOwnerId ?? '') ||
      typeof value.expiresAtUtc !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAtUtc)) ||
      Date.parse(value.expiresAtUtc) <= Date.now()
    ) {
      throw denied();
    }
    return Object.fromEntries([...identityKeys, 'expiresAtUtc'].map((key) => [key, value[key]]));
  };
  const match = (left, right) => {
    if (identityKeys.some((key) => left[key] !== right[key])) {
      throw denied();
    }
  };
  const owner = (user, central) => {
    if (
      !user ||
      String(user._id) !== central.chatOwnerId ||
      user.role !== 'USER' ||
      user.agentTriggerDeletionStartedAt != null ||
      user.expiresAt != null ||
      user.tenantId
    ) {
      throw denied();
    }
    return user;
  };
  const attach = (user, central) => ({
    ...(typeof user.toObject === 'function' ? user.toObject() : user),
    id: String(user._id),
    memberId: central.memberId,
    reference: central.reference,
    centralSessionReference: central.reference,
    centralSession: central,
  });
  const request = async (action, body) => {
    assertConfig();
    const controller = new AbortController();
    let timer;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(denied(503));
        }, 2500);
      });
      return await Promise.race([
        deadline,
        (async () => {
          const response = await fetchImpl(`${API_URL}/internal/central-sso/${action}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-OpenSchool-Central-Key': env.OPENSCHOOL_CENTRAL_API_KEY,
            },
            body: JSON.stringify(body),
            redirect: 'error',
            signal: controller.signal,
          });
          if (action === 'revoke' && response.status === 204) {
            return;
          }
          if (action === 'revoke' || response.status !== 200) {
            throw denied(response.status === 401 ? 401 : 503);
          }
          return binding(await response.json());
        })(),
      ]);
    } catch (error) {
      throw denied(error.status === 401 ? 401 : 503);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
  const validate = async (stored) => {
    const expected = binding(stored);
    const live = await request('validate', { reference: expected.reference });
    match(expected, live);
    return {
      ...live,
      expiresAtUtc: new Date(
        Math.min(Date.parse(expected.expiresAtUtc), Date.parse(live.expiresAtUtc)),
      ).toISOString(),
    };
  };
  const registerVerified = async (tokenset, findUser, existingUsersOnly) => {
    assertConfig();
    if (existingUsersOnly || typeof tokenset?.claims !== 'function' || !tokenset.id_token) {
      throw denied();
    }
    const claims = tokenset.claims();
    if (
      claims?.iss !== ISSUER ||
      !identifier(claims.sub) ||
      !identifier(claims.sid) ||
      !(Array.isArray(claims.aud) ? claims.aud.includes(CLIENT_ID) : claims.aud === CLIENT_ID) ||
      !Number.isFinite(claims.exp) ||
      claims.exp * 1000 <= Date.now()
    ) {
      throw denied();
    }
    const central = await request('register', { idToken: tokenset.id_token });
    if (central.subject !== claims.sub || central.sid !== claims.sid) {
      throw denied();
    }
    const user = owner(
      await findUser(
        { _id: central.chatOwnerId },
        '-password -totpSecret -backupCodes +agentTriggerDeletionStartedAt',
      ),
      central,
    );
    const authenticated = attach(user, central);
    callbackGrants.set(authenticated, central);
    return authenticated;
  };
  const prepareTokens = async (userId, session, req, getUserById) => {
    assertConfig();
    const grant = session ? session.centralSession : callbackGrants.get(req?.user);
    if (!session && req?.user) {
      callbackGrants.delete(req.user);
    }
    const central = await validate(grant);
    if (
      String(userId) !== central.chatOwnerId ||
      (session && String(session.user) !== central.chatOwnerId)
    ) {
      throw denied();
    }
    const user = owner(
      await getUserById(
        userId,
        '-password -totpSecret -backupCodes +agentTriggerDeletionStartedAt',
      ),
      central,
    );
    req.user = attach(user, central);
    return { central, user: req.user };
  };
  const authorize = async (payload, user, findSession) => {
    assertConfig();
    const signed = binding(payload.centralSession);
    if (!OWNER.test(payload.sessionId ?? '') || payload.id !== signed.chatOwnerId) {
      throw denied();
    }
    const session = await findSession({ userId: payload.id, sessionId: payload.sessionId });
    if (!session || String(session.user) !== payload.id) {
      throw denied();
    }
    match(signed, binding(session.centralSession));
    const central = await validate(session.centralSession);
    return attach(owner(user, central), central);
  };
  const logout = async (req, res, { deleteSession, clearCloudFrontCookies }) => {
    assertConfig();
    const central = binding(req.user?.centralSession);
    if (!OWNER.test(req.centralSessionId ?? '')) {
      throw denied();
    }
    await request('revoke', { reference: central.reference });
    await deleteSession({ sessionId: req.centralSessionId });
    if (req.session) {
      await new Promise((resolve, reject) =>
        req.session.destroy((error) => (error ? reject(denied(503)) : resolve())),
      );
    }
    for (const name of [
      'refreshToken',
      'token_provider',
      'openid_access_token',
      'openid_id_token',
      'openid_user_id',
      'connect.sid',
    ]) {
      res.clearCookie(name);
    }
    clearCloudFrontCookies(res, { userId: central.chatOwnerId });
    const endSession = new URL(`${ISSUER}/protocol/openid-connect/logout`);
    endSession.searchParams.set('client_id', CLIENT_ID);
    endSession.searchParams.set('post_logout_redirect_uri', LOGOUT_REDIRECT);
    return res.status(200).send({
      message: 'Chat session revoked; identity-provider logout pending',
      redirect: endSession.toString(),
    });
  };
  const guardRoutes = (kind) => (req, res, next) => {
    if (!enabled()) {
      return next();
    }
    const path = req.path.toLowerCase().replace(/\/+$/, '') || '/';
    const allowed =
      kind === 'oauth'
        ? ['/openid', '/openid/callback', '/error'].includes(path)
        : kind === 'auth' &&
          ![
            '/login',
            '/register',
            '/requestpasswordreset',
            '/resetpassword',
            '/2fa/verify-temp',
          ].includes(path);
    if (!allowed) {
      return res.status(403).json({ message: 'Central OpenID login required' });
    }
    try {
      assertConfig();
    } catch {
      return res.status(503).json({ message: 'Central SSO configuration unavailable' });
    }
    return next();
  };
  return {
    enabled,
    assertConfig,
    binding,
    match,
    owner,
    validate,
    registerVerified,
    prepareTokens,
    authorize,
    logout,
    guardRoutes,
  };
}

module.exports = { ...createCentralSSO(), createCentralSSO };
