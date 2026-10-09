const { parseCentralModelCatalog, resolveCentralModelScope } = require('@librechat/api');
const centralSSO = require('./LocalCentralSSO');
const trustProfiles = require('./CentralTrustProfile');
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function identityHeaders(user) {
  if (!UUID.test(user?.memberId ?? '') || !UUID.test(user?.centralSessionReference ?? '')) {
    const error = new Error('Central gateway identity unavailable');
    error.status = 401;
    throw error;
  }
  return {
    'X-OpenSchool-Member-Id': user.memberId,
    'X-OpenSchool-Central-Session': user.centralSessionReference,
  };
}

/** Validated `{ ids, names, circleIds }` for the current user from the central gateway. */
async function modelCatalog(user) {
  const headers = identityHeaders(user);
  if (!centralSSO.enabled() || !process.env.OPENSCHOOL_GATEWAY_KEY) {
    throw new Error('Central gateway configuration unavailable');
  }
  // Use the same validated, fixed destination as the central session service.
  // Neither caller input nor a custom endpoint can override this trust profile.
  const profile = trustProfiles.validate(process.env);
  const response = await fetch(`${profile.api}/ai-gateway/v1/models`, {
    headers: { ...headers, Authorization: `Bearer ${process.env.OPENSCHOOL_GATEWAY_KEY}` },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error('Central model eligibility unavailable');
    error.status = [401, 403].includes(response.status) ? response.status : 503;
    throw error;
  }
  return parseCentralModelCatalog(await response.json());
}

/** Fresh per-user eligibility; accepts a model ID, never a caller-supplied circle or catalog. */
async function modelScope(user, model) {
  return resolveCentralModelScope(await modelCatalog(user), model);
}

async function models(user) {
  const { ids } = await modelCatalog(user);
  return { OpenSchool: ids };
}

module.exports = { identityHeaders, models, modelCatalog, modelScope };
