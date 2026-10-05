const { logger } = require('@librechat/data-schemas');
const centralSSO = require('./LocalCentralSSO');
const { modelCatalog } = require('./CentralGateway');
const db = require('~/models');

const OPENSCHOOL_ENDPOINT = 'OpenSchool';

function isNewConversation(conversationId) {
  return !conversationId || conversationId === 'new';
}

/**
 * A new central-SSO conversation on a circle model is filed under the user's project named
 * after that circle. The project name comes only from the gateway's trusted per-user names;
 * the client's `chatProjectId` (including `null`) is discarded for these conversations. When
 * no trusted name exists or anything fails, the chat proceeds without a project.
 *
 * Existing conversations, other endpoints and non-circle models are returned unchanged.
 *
 * @param {ServerRequest} req
 * @param {Record<string, unknown>} parsedBody
 * @returns {Promise<Record<string, unknown>>}
 */
async function applyCircleProject(req, parsedBody) {
  const model = parsedBody?.model ?? req.body?.model;
  if (
    !centralSSO.enabled() ||
    req.body?.endpoint !== OPENSCHOOL_ENDPOINT ||
    typeof model !== 'string' ||
    !model.startsWith('circle-') ||
    !isNewConversation(req.body?.conversationId)
  ) {
    return parsedBody;
  }

  const { chatProjectId: _clientProjectId, ...rest } = parsedBody ?? {};
  delete req.body.chatProjectId;

  try {
    const { names } = await modelCatalog(req.user);
    const name = Object.hasOwn(names, model) ? names[model] : undefined;
    if (!name) {
      logger.warn('[CentralCircleProject] No trusted circle name; conversation has no project');
      return rest;
    }
    const project = await db.getOrCreateChatProjectByName(req.user.id, name);
    const chatProjectId = project?._id?.toString();
    if (!chatProjectId) {
      return rest;
    }
    req.body.chatProjectId = chatProjectId;
    return { ...rest, chatProjectId };
  } catch (error) {
    logger.warn('[CentralCircleProject] Circle project unavailable; conversation has no project', {
      status: error?.status,
    });
    return rest;
  }
}

module.exports = { applyCircleProject };
