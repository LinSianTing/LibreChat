const LOCAL = Object.freeze({
  issuer: 'http://localhost:15480/realms/langrace-local',
  api: 'http://localhost:15481',
  client: 'chat-local',
  origin: 'http://localhost:15483',
  prefix: '',
});
const DEMO = Object.freeze({
  issuer: 'https://openschool.langracetech.com/identity/realms/openschool',
  api: 'http://school:8080',
  client: 'chat-demo',
  origin: 'https://openschool.langracetech.com',
  prefix: '/chat',
});
const select = (env) => (env.OPENSCHOOL_CENTRAL_PROFILE === 'demo' ? DEMO : LOCAL);
function validate(env) {
  const demo = env.OPENSCHOOL_CENTRAL_PROFILE === 'demo';
  const profile = select(env);
  if (
    (env.OPENSCHOOL_CENTRAL_PROFILE &&
      !['local', 'demo'].includes(env.OPENSCHOOL_CENTRAL_PROFILE)) ||
    env.NODE_ENV !== (demo ? 'production' : 'development') ||
    env.OPENID_ISSUER !== profile.issuer ||
    env.OPENID_CLIENT_ID !== profile.client ||
    env.OPENSCHOOL_CENTRAL_API_URL !== profile.api ||
    !env.OPENSCHOOL_CENTRAL_API_KEY?.trim() ||
    /^(true|1)$/i.test((env.OPENID_REUSE_TOKENS ?? '').trim())
  ) {
    throw Object.assign(new Error('Central trust profile unavailable'), { status: 503 });
  }
  if (
    demo &&
    (env.DOMAIN_CLIENT !== profile.origin + profile.prefix ||
      env.DOMAIN_SERVER !== profile.origin + profile.prefix ||
      env.OPENID_CALLBACK_URL !== '/oauth/openid/callback' ||
      env.OPENID_USE_PKCE !== 'true' ||
      env.USE_REDIS !== 'true' ||
      !/^redis:\/\/:[A-Za-z0-9]{32,}@chat-session:6379\/0$/.test(env.REDIS_URI ?? '') ||
      env.OPENSCHOOL_CENTRAL_API_KEY.length < 32 ||
      !env.OPENID_CLIENT_SECRET ||
      env.OPENID_CLIENT_SECRET.length < 32)
  ) {
    throw Object.assign(new Error('Central demo transport configuration unavailable'), {
      status: 503,
    });
  }
  return profile;
}
module.exports = { select, validate };
