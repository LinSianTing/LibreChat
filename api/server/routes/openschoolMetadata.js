const mongoose = require('mongoose');
const { createConversationMetadataRouter } = require('@librechat/api');
const { createConversationMetadataQuery } = require('@librechat/data-schemas');
const trustProfiles = require('../services/CentralTrustProfile');

module.exports = createConversationMetadataRouter({
  env: process.env,
  resolveProfile: () => trustProfiles.validate(process.env),
  fetchImpl: (...args) => fetch(...args),
  query: createConversationMetadataQuery(mongoose.connection, {
    namespace: process.env.OPENSCHOOL_METADATA_NAMESPACE,
    tenantId: process.env.OPENSCHOOL_METADATA_TENANT_ID,
  }),
});
