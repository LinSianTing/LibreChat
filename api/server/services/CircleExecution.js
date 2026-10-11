const mongoose = require('mongoose');
const { createCircleExecution, circleExecutionOptions } = require('@librechat/api');
const {
  createMongoBindingStore,
  createConversationPresence,
  logger,
} = require('@librechat/data-schemas');
const { modelScope } = require('./CentralGateway');

const options = circleExecutionOptions(process.env);
module.exports = createCircleExecution({
  ...options,
  store: () => createMongoBindingStore(mongoose.connection, options.binding),
  presence: createConversationPresence(mongoose.connection, options.tenantId),
  scope: modelScope,
  report: () => logger.warn('OpenSchool circle execution could not be confirmed'),
});
