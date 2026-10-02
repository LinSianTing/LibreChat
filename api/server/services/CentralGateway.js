const centralSSO = require('./LocalCentralSSO');
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

async function models(user) {
  const headers = identityHeaders(user);
  if (
    !centralSSO.enabled() ||
    process.env.NODE_ENV !== 'development' ||
    !process.env.OPENSCHOOL_GATEWAY_KEY
  ) {
    throw new Error('Central gateway configuration unavailable');
  }
  // Fixed local P0 destination, no default-model fallback or cross-user cache.
  const response = await fetch('http://localhost:15481/ai-gateway/v1/models', {
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
  const data = await response.json();
  if (
    data.object !== 'list' ||
    !Array.isArray(data.data) ||
    data.data.length > 1000 ||
    data.data.some(
      (entry) =>
        typeof entry.id !== 'string' || !/^(personal|circle-[a-z0-9-]{1,64})$/.test(entry.id),
    )
  ) {
    throw new Error('Invalid central model response');
  }
  return { OpenSchool: [...new Set(data.data.map((entry) => entry.id))] };
}

module.exports = { identityHeaders, models };
