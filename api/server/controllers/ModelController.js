const { logger } = require('@librechat/data-schemas');
const { loadDefaultModels, loadConfigModels } = require('~/server/services/Config');
const centralSSO = require('~/server/services/LocalCentralSSO');
const centralGateway = require('~/server/services/CentralGateway');

const getModelsConfig = (req) => loadModels(req);

async function loadModels(req) {
  if (centralSSO.enabled()) return centralGateway.models(req.user);
  const [defaultModelsConfig, customModelsConfig] = await Promise.all([
    loadDefaultModels(req),
    loadConfigModels(req),
  ]);
  return { ...defaultModelsConfig, ...customModelsConfig };
}

async function modelController(req, res) {
  try {
    if (centralSSO.enabled()) res.set('Cache-Control', 'private, no-store');
    const modelConfig = await loadModels(req);
    res.send(modelConfig);
  } catch (error) {
    if (centralSSO.enabled())
      return res
        .status(error.status ?? 503)
        .send({ error: 'Central model eligibility unavailable' });
    logger.error('Error fetching models:', error);
    res.status(500).send({ error: error.message });
  }
}

module.exports = { modelController, loadModels, getModelsConfig };
