// Local SSO contract only. Callers must first validate the OIDC token and live session.
// No registration, email fallback, role synchronization or database mutation is permitted.
const LOCAL_ISSUER = 'http://localhost:15480/realms/langrace-local';

const identifier = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 255 &&
  value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);

function createLocalCentralIdentity({ enabled, environment, issuer, bindings }) {
  if (enabled !== true) {
    return null;
  }
  if (environment !== 'development' || issuer !== LOCAL_ISSUER || !Array.isArray(bindings)) {
    throw new Error('Invalid local central identity configuration');
  }
  const bySubject = new Map();
  const googleIds = new Set();
  const chatIds = new Set();
  const memberIds = new Set();
  for (const binding of bindings) {
    if (!binding || binding.issuer !== LOCAL_ISSUER || !identifier(binding.subject) ||
        !identifier(binding.googleSubject) || binding.googleSubject.startsWith('deleted:') ||
        !/^[0-9a-f]{24}$/.test(binding.chatUserId ?? '') ||
        !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(binding.memberId ?? '') ||
        binding.memberId === '00000000-0000-0000-0000-000000000000' ||
        bySubject.has(binding.subject) || googleIds.has(binding.googleSubject) ||
        chatIds.has(binding.chatUserId) || memberIds.has(binding.memberId)) {
      throw new Error('Invalid or conflicting local central identity binding');
    }
    bySubject.set(binding.subject, Object.freeze({ ...binding }));
    googleIds.add(binding.googleSubject);
    chatIds.add(binding.chatUserId);
    memberIds.add(binding.memberId);
  }
  return Object.freeze({
    // `claims` must originate from the OIDC library, never request body or decoded-only JWT.
    async resolveVerifiedClaims(claims, { findUser, isActive }) {
      if (!claims || claims.iss !== LOCAL_ISSUER || !identifier(claims.sub) ||
          !identifier(claims.sid)) {
        return null;
      }
      const binding = bySubject.get(claims.sub);
      if (!binding) {
        return null;
      }
      // Always re-read the exact owner. A cached email/account match is not authorization.
      const user = await findUser({ _id: binding.chatUserId });
      if (!user || String(user._id) !== binding.chatUserId ||
          user.googleId !== binding.googleSubject || user.provider !== 'google' ||
          user.tenantId || !user.role || user.openidId || user.openidIssuer ||
          !(await isActive(binding.chatUserId))) {
        return null;
      }
      // Keep the stored Google account untouched; session metadata is separate from the user.
      return Object.freeze({
        user,
        identity: Object.freeze({
          issuer: LOCAL_ISSUER,
          subject: binding.subject,
          sessionId: claims.sid,
          memberId: binding.memberId,
          chatUserId: binding.chatUserId,
        }),
      });
    },
  });
}

module.exports = { createLocalCentralIdentity, LOCAL_ISSUER };
