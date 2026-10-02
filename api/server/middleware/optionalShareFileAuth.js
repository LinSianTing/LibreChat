const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const centralSSO = require('~/server/services/LocalCentralSSO');
const { isEnabled } = require('@librechat/api');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');
const { getUserById, findSession } = require('~/models');

const verifySignedUserId = (token) => {
  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    return typeof payload?.id === 'string' ? payload.id : null;
  } catch {
    return null;
  }
};

const getRefreshTokenUserId = async (token) => {
  const userId = verifySignedUserId(token);
  if (!userId) {
    return null;
  }

  const session = await runAsSystem(() => findSession({ userId, refreshToken: token }));
  return session ? userId : null;
};

const getOpenIdUserId = (parsed, req) => {
  if (parsed.token_provider !== 'openid' || !isEnabled(process.env.OPENID_REUSE_TOKENS)) {
    return null;
  }

  const sessionRefreshToken = req.session?.openidTokens?.refreshToken;
  if (!parsed.refreshToken || parsed.refreshToken !== sessionRefreshToken) {
    return null;
  }

  return verifySignedUserId(parsed.openid_user_id);
};

/**
 * Fallback auth for share file routes that are hit by `<img>`/anchor requests,
 * which can't carry the bearer access token. Resolves the viewer from the
 * `refreshToken` cookie (or an active OpenID session plus signed `openid_user_id`
 * cookie) so non-public shared links can authorize the viewer's ACL. Never
 * blocks: on any failure it leaves `req.user` unset and lets
 * `canAccessSharedLink` decide (public access, 401, or 403).
 */
const optionalShareFileAuth = async (req, res, next) => {
  if (centralSSO.enabled()) {
    if (req.user?.centralSession && req.authStrategy === 'jwt') {
      return next();
    }
    if (req.headers.authorization) {
      return res.status(401).json({ message: 'Central session is not authorized' });
    }
    try {
      const token = cookie.parse(req.headers.cookie || '').refreshToken;
      req.user = await runAsSystem(() =>
        centralSSO.authenticateRefresh(token, {
          verifyToken: jwt.verify,
          findSession,
          getUserById,
        }),
      );
      return next();
    } catch (error) {
      return res
        .status(error.status === 503 ? 503 : 401)
        .json({ message: 'Central session is not authorized' });
    }
  }
  if (req.user) {
    return next();
  }

  try {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) {
      return next();
    }

    const parsed = cookie.parse(cookieHeader);
    const userId =
      getOpenIdUserId(parsed, req) ||
      (parsed.refreshToken ? await getRefreshTokenUserId(parsed.refreshToken) : null);
    if (!userId) {
      return next();
    }

    // Resolve in system context: this runs before canAccessSharedLink establishes
    // the share tenant, so under strict tenant isolation a tenant-scoped User
    // query would otherwise throw. The viewer's id comes from verified, active
    // cookie auth; the share's tenant-scoped ACL check still gates access.
    const user = await runAsSystem(() =>
      getUserById(userId, '-password -__v -totpSecret -backupCodes'),
    );
    if (user) {
      user.id = user._id.toString();
      if (!user.role) {
        user.role = SystemRoles.USER;
      }
      req.user = user;
    }
  } catch (error) {
    logger.warn('[optionalShareFileAuth] cookie auth failed:', error?.message);
  }

  return next();
};

module.exports = optionalShareFileAuth;
