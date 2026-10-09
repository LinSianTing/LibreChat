const { EventEmitter } = require('events');
const { createCircleExecution } = require('../../../packages/api/src/openschool/execution');
let mockRuntime;
jest.mock('~/server/services/CircleExecution', () => ({
  beforeOptions: (...args) => mockRuntime.beforeOptions(...args),
}));
jest.mock('@librechat/api', () => ({ handleError: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({ logger: { error: jest.fn() } }));
jest.mock('librechat-data-provider', () => ({
  EndpointURLs: { agents: '/api/agents' },
  EModelEndpoint: { agents: 'agents' },
  isAgentsEndpoint: () => false,
  getDefaultParamsEndpoint: () => 'custom',
  parseCompactConvo: ({ conversation }) => ({ ...conversation }),
  Constants: { NO_PARENT: 'none' },
  RetentionMode: { ALL: 'all' },
  openAISettings: { model: { default: 'synthetic' } },
}));
const mockProject = jest.fn(async (_req, body) => body);
const mockBuilder = jest.fn(async (_req, endpoint, body) => ({
  endpoint,
  model_parameters: { model: body.model },
}));
jest.mock('~/server/services/CentralCircleProject', () => ({
  applyCircleProject: (...args) => mockProject(...args),
}));
jest.mock('~/server/services/Endpoints/agents', () => ({
  buildOptions: (...args) => mockBuilder(...args),
}));
jest.mock('~/server/services/Endpoints/assistants', () => ({}));
jest.mock('~/server/services/Endpoints/azureAssistants', () => ({}));
jest.mock('~/server/services/Config', () => ({ getEndpointsConfig: async () => ({}) }));
jest.mock('~/models', () => ({ updateFilesUsage: jest.fn() }));
jest.mock('~/server/utils/import/defaults', () => ({ FALLBACK_MODEL_BY_ENDPOINT: {} }));
const buildEndpointOption = require('./buildEndpointOption');
const { ImportBatchBuilder } = require('../utils/import/importBatchBuilder');
const owner = '111111111111111111111111';
const member = '22222222-2222-4222-8222-222222222222';
const originalId = '33333333-3333-4333-8333-333333333333';
const circle = '44444444-4444-4444-8444-444444444444';
const binding = {
  version: 1,
  key: { chatOwnerId: owner, conversationId: originalId },
  memberId: member,
  scope: { endpoint: 'OpenSchool', model: 'circle-a', circleId: circle },
};
beforeEach(() => jest.clearAllMocks());

test('real endpoint middleware denies before project creation, agent builder or downstream history/provider', async () => {
  mockRuntime = createCircleExecution({
    enabled: true,
    store: () => ({ read: async () => ({ kind: 'bound', binding }) }),
    scope: async () => ({
      kind: 'resolved',
      value: {
        endpoint: 'OpenSchool',
        model: 'circle-b',
        circleId: '55555555-5555-4555-8555-555555555555',
      },
    }),
    report: jest.fn(),
  });
  const req = {
    user: { id: owner, memberId: member },
    baseUrl: '/api/agents',
    config: {},
    body: { endpoint: 'OpenSchool', model: 'circle-b', conversationId: originalId },
  };
  const res = Object.assign(new EventEmitter(), {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  });
  const next = jest.fn();
  await buildEndpointOption(req, res, next);
  expect(res.status).toHaveBeenCalledWith(409);
  expect(mockProject).not.toHaveBeenCalled();
  expect(mockBuilder).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
});

test('formal import/fork builder creates a separate ID and its persisted copy can continue unbound', async () => {
  const builder = new ImportBatchBuilder(owner);
  builder.startConversation('OpenSchool');
  const { conversation } = builder.finishConversation('Synthetic fork', new Date(), {
    conversationId: originalId,
    endpoint: 'OpenSchool',
    model: 'circle-a',
  });
  expect(conversation.conversationId).not.toBe(originalId);
  const insertIfAbsent = jest.fn();
  const scope = jest.fn();
  mockRuntime = createCircleExecution({
    enabled: true,
    store: () => ({
      read: async (key) =>
        key.conversationId === originalId ? { kind: 'bound', binding } : { kind: 'absent' },
      insertIfAbsent,
    }),
    presence: async () => 'owned',
    scope,
    report: jest.fn(),
  });
  const req = {
    user: { id: owner, memberId: member },
    baseUrl: '/api/agents',
    config: {},
    body: { ...conversation },
  };
  const res = Object.assign(new EventEmitter(), {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  });
  const next = jest.fn();
  await buildEndpointOption(req, res, next);
  expect(next).toHaveBeenCalled();
  expect(insertIfAbsent).not.toHaveBeenCalled();
  expect(scope).not.toHaveBeenCalled();
  expect(binding.key.conversationId).toBe(originalId);
});
