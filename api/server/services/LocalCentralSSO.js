const trustProfiles = require('./CentralTrustProfile');
const { createCentralLogout } = require('./CentralLogout');
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
  // eslint-disable-next-line no-control-regex -- Identity fields must reject ASCII control characters.
  !/[\x00-\x1f\x7f]/.test(value);

function denied(status = 401) {
  const error = new Error('Central session is not authorized');
  error.status = status;
  return error;
}

/** Local-only server contract; callback grants cannot be reconstructed from request input. */
function createCentralSSO({ env = process.env, fetchImpl = (...args) => fetch(...args) } = {}) {
  // Demo must never silently fall back to legacy authentication.
  if (env.OPENSCHOOL_CENTRAL_PROFILE === 'demo') trustProfiles.validate(env);
  const profile = trustProfiles.select(env);
  const { issuer: ISSUER, api: API_URL, client: CLIENT_ID } = profile;
  const callbackGrants = new WeakMap();
  const enabled = () => String(env.OPENSCHOOL_CENTRAL_SSO).trim().toLowerCase() === 'true';
  const assertConfig = () => {
    if (!enabled()) throw denied(503);
    trustProfiles.validate(env);
  };
  const binding = (value, { allowExpired = false } = {}) => {
    if (
      !value ||
      typeof value.reference !== 'string' ||
      !UUID.test(value.reference ?? '') ||
      typeof value.memberId !== 'string' ||
      !UUID.test(value.memberId ?? '') ||
      value.issuer !== ISSUER ||
      value.clientId !== CLIENT_ID ||
      !identifier(value.subject) ||
      !identifier(value.sid) ||
      typeof value.chatOwnerId !== 'string' ||
      !OWNER.test(value.chatOwnerId ?? '') ||
      typeof value.expiresAtUtc !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAtUtc)) ||
      (!allowExpired && Date.parse(value.expiresAtUtc) <= Date.now())
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
    callbackGrants.set(authenticated, { central, logoutIdToken: tokenset.id_token });
    return authenticated;
  };
  const prepareTokens = async (userId, session, req, getUserById) => {
    assertConfig();
    const grant = session ? { central: session.centralSession } : callbackGrants.get(req?.user);
    if (!session && req?.user) {
      callbackGrants.delete(req.user);
    }
    const central = await validate(grant?.central);
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
    return { central, user: req.user, logoutIdToken: grant.logoutIdToken };
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
  const logoutFlow = createCentralLogout({
    assertConfig,
    binding,
    match,
    revoke: (reference) => request('revoke', { reference }),
    env,
  });
  const authenticateRefresh = async (token, { verifyToken, findSession, getUserById }) => {
    assertConfig();
    const payload = verifyToken(token, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
    const signed = binding(payload?.centralSession);
    if (
      payload.id !== signed.chatOwnerId ||
      typeof payload.sessionId !== 'string' ||
      !OWNER.test(payload.sessionId)
    ) {
      throw denied();
    }
    const session = await findSession({
      userId: payload.id,
      sessionId: payload.sessionId,
      refreshToken: token,
    });
    if (!session || String(session._id) !== payload.sessionId) {
      throw denied();
    }
    const user = await getUserById(
      payload.id,
      '-password -__v -totpSecret -backupCodes +agentTriggerDeletionStartedAt',
    );
    return authorize(payload, user, async () => session);
  };
  const checkBrowserSession = async (authenticatedUser, refreshToken, deps) => {
    // Read-only: an old tab may share cookies with a newer login. Never revoke either here.
    const original = binding(authenticatedUser?.centralSession);
    const current = await authenticateRefresh(refreshToken, deps);
    match(original, binding(current.centralSession));
  };
  const guardRoutes = (kind) => (req, res, next) => {
    if (!enabled()) {
      if (env.OPENSCHOOL_CENTRAL_PROFILE === 'demo') {
        return res.status(503).json({ message: 'Central SSO configuration unavailable' });
      }
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
    ...logoutFlow,
    authenticateRefresh,
    checkBrowserSession,
    guardRoutes,
  };
}

module.exports = { ...createCentralSSO(), createCentralSSO };
