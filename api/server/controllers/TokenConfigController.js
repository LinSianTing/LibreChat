const { logger } = require('@librechat/data-schemas');
const { resolveTokenConfigMap } = require('@librechat/api');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { getValueKey, getMultiplier, getCacheMultiplier } = require('~/models');
const centralSSO = require('~/server/services/LocalCentralSSO');

/**
 * Returns server-resolved context windows (and pricing when
 * `interface.contextCost` is enabled) for every configured model. Resolution
 * lives in `@librechat/api`; this controller only supplies request-scoped deps.
 * @param {ServerRequest} req
 * @param {ServerResponse} res
 */
async function tokenConfigController(req, res) {
  if (centralSSO.enabled()) res.set('Cache-Control', 'private, no-store');
  try {
    const modelsConfig = await getModelsConfig(req);
    const tokenConfigMap = await resolveTokenConfigMap(
      {
        appConfig: req.config,
        modelsConfig,
        userId: req.user.id,
        tenantId: req.user.tenantId,
      },
      { getValueKey, getMultiplier, getCacheMultiplier },
    );
    res.json(tokenConfigMap);
  } catch (error) {
    if (centralSSO.enabled()) {
      const status = [401, 403].includes(error?.status) ? error.status : 503;
      return res.status(status).json({ error: 'Central model eligibility unavailable' });
    }
    logger.error('[tokenConfigController]', error);
    res.status(500).json({ error: 'Failed to resolve token config' });
  }
}

module.exports = tokenConfigController;
