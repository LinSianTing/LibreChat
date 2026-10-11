const express = require('express');
const request = require('supertest');
const { createCircleExecution } = require('../../../../packages/api/src/openschool/execution');
let mockCircleRuntime = createCircleExecution({ enabled: false });
let mockCircleUser;
jest.mock('~/server/services/CircleExecution', () => ({
  mutation:
    (controller, storedScope) =>
    (...args) =>
      mockCircleRuntime.mutation(controller, storedScope)(...args),
}));

const mockIsSubagentThreadWriteBlocked = jest.fn();

jest.mock('@librechat/agents', () => ({ sleep: jest.fn() }));

jest.mock('@librechat/api', () => ({
  withoutTraceRefs: jest.fn((message) => message),
  createContentFilter: jest.fn(() => (_req, _res, next) => next()),
  unescapeLaTeX: jest.fn((value) => value),
  countTokens: jest.fn().mockResolvedValue(1),
  sendFeedbackScore: jest.fn().mockResolvedValue(undefined),
  traceIdForMessage: jest.fn((messageId) => `trace-${messageId}`),
  mergeQuotedTextForCount: jest.fn((text) => text),
  assertStoredMessageMutationAllowed: jest.fn(),
  assertChatMutationAllowed: jest.fn(),
  assertStoredMessageBranchAllowed: jest.fn(),
  mergeUserSubmittedPaths: (...lists) => [...new Set(lists.flat().filter(Boolean))],
  mergeUserSubmittedMessageFieldPaths: (...lists) => lists.flat().filter(Boolean),
  isContentFilterError: jest.fn(() => false),
  CHILD_THREAD_READ_ONLY_ERROR: 'This subagent thread is view-only.',
  isSubagentThreadWriteBlocked: (...args) => mockIsSubagentThreadWriteBlocked(...args),
  requireFeedbackEnabled: (req, res, next) => next(),
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
}));

jest.mock('~/models', () => ({
  getConvo: jest.fn(),
  getMessage: jest.fn(),
  getMessages: jest.fn(),
  saveConvo: jest.fn(),
  saveMessage: jest.fn(),
  updateMessage: jest.fn(),
  deleteMessages: jest.fn(),
  getConvosQueried: jest.fn(),
  searchMessages: jest.fn(),
  getMessagesByCursor: jest.fn(),
}));

jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () => ({
  isThreadActiveForOwner: jest.fn(),
}));

jest.mock('~/server/services/Artifacts/update', () => ({
  findAllArtifacts: jest.fn(),
  replaceArtifactContent: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => next(),
  validateMessageReq: (req, _res, next) => next(),
  configMiddleware: (req, _res, next) => next(),
  sendValidationResponse: jest.fn(),
  prepareMessageRequestValidation: jest.fn(),
}));

describe('message mutation policy for durable subagent threads', () => {
  let app;
  const db = require('~/models');

  beforeAll(() => {
    const messagesRouter = require('../messages');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = mockCircleUser ?? { id: 'owner-user', tenantId: 'tenant-a' };
      next();
    });
    app.use('/api/messages', messagesRouter);
  });

  beforeEach(() => {
    mockCircleRuntime = createCircleExecution({ enabled: false });
    mockCircleUser = undefined;
    jest.clearAllMocks();
    mockIsSubagentThreadWriteBlocked.mockResolvedValue(true);
    db.getMessage.mockResolvedValue({
      messageId: 'message-1',
      conversationId: 'child-conversation',
      isCreatedByUser: false,
      content: [],
    });
    db.getMessages.mockResolvedValue([
      {
        messageId: 'message-1',
        conversationId: 'child-conversation',
        isCreatedByUser: false,
        content: [],
      },
    ]);
  });

  it.each(
    ['text', 'part'].flatMap((edit) =>
      ['revoked', 'deleted', 'pending', 'allowed', 'legacy'].map((state) => [edit, state]),
    ),
  )('PUT %s respects %s circle admission and occupancy', async (edit, state) => {
    const conversationId = '33333333-3333-4333-8333-333333333333';
    mockCircleUser = {
      id: '111111111111111111111111',
      memberId: '22222222-2222-4222-8222-222222222222',
    };
    const key = { chatOwnerId: mockCircleUser.id, conversationId };
    const scope = {
      endpoint: 'OpenSchool',
      model: 'circle-a',
      circleId: '44444444-4444-4444-8444-444444444444',
    };
    const release = jest.fn();
    const acquire = jest.fn(async () => state !== 'pending');
    mockCircleRuntime = createCircleExecution({
      enabled: true,
      presence: async () => 'owned',
      report: jest.fn(),
      store: () => ({
        read: async () => {
          if (state === 'legacy') return { kind: 'absent' };
          if (state === 'deleted') return { kind: 'tombstone', key };
          return {
            kind: 'bound',
            binding: { version: 1, key, memberId: mockCircleUser.memberId, scope },
          };
        },
        acquire,
        release,
      }),
      scope: async () =>
        state === 'revoked' ? { kind: 'unavailable' } : { kind: 'resolved', value: scope },
    });
    mockIsSubagentThreadWriteBlocked.mockResolvedValue(false);
    db.getMessages.mockResolvedValue([
      {
        messageId: 'message-1',
        conversationId,
        text: 'old',
        content: [{ type: 'text', text: 'old' }],
      },
    ]);
    db.updateMessage.mockImplementation(async () => {
      if (state !== 'legacy') expect(acquire).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
      return { conversationId, messageId: 'message-1' };
    });
    const result = await request(app)
      .put(`/api/messages/${conversationId}/message-1`)
      .send({
        text: 'edited',
        model: 'token-counter-model',
        ...(edit === 'part' ? { index: 0 } : {}),
      });
    if (state === 'allowed' || state === 'legacy') {
      expect(result.status).toBe(200);
      expect(db.updateMessage).toHaveBeenCalledWith(mockCircleUser.id, expect.anything(), {
        conversationIdFence: conversationId,
      });
      expect(release).toHaveBeenCalledTimes(state === 'allowed' ? 1 : 0);
    } else {
      expect(result.status).toBe(state === 'revoked' ? 503 : 409);
      expect(db.updateMessage).not.toHaveBeenCalled();
    }
  });

  it.each(['circle', 'endpoint', 'deleted'])(
    'independent save rejects %s before message or conversation write',
    async (kind) => {
      const conversationId = '33333333-3333-4333-8333-333333333333';
      mockCircleUser = {
        id: '111111111111111111111111',
        memberId: '22222222-2222-4222-8222-222222222222',
      };
      const scope = {
        endpoint: 'OpenSchool',
        model: 'circle-a',
        circleId: '44444444-4444-4444-8444-444444444444',
      };
      mockCircleRuntime = createCircleExecution({
        enabled: true,
        presence: async () => 'owned',
        report: jest.fn(),
        store: () => ({
          read: async () =>
            kind === 'deleted'
              ? { kind: 'tombstone', key: { chatOwnerId: mockCircleUser.id, conversationId } }
              : {
                  kind: 'bound',
                  binding: {
                    version: 1,
                    key: { chatOwnerId: mockCircleUser.id, conversationId },
                    memberId: mockCircleUser.memberId,
                    scope,
                  },
                },
        }),
        scope: async () => ({
          kind: 'resolved',
          value: { ...scope, circleId: '55555555-5555-4555-8555-555555555555' },
        }),
      });
      const result = await request(app)
        .post(`/api/messages/${conversationId}`)
        .send({
          messageId: 'synthetic',
          endpoint: kind === 'endpoint' ? 'agents' : 'OpenSchool',
          model: 'circle-b',
        });
      expect(result.status).toBe(409);
      expect(db.saveMessage).not.toHaveBeenCalled();
      expect(db.saveConvo).not.toHaveBeenCalled();
    },
  );

  it('independent admitted save uses atomic message identity fence and never upserts conversation', async () => {
    const conversationId = '33333333-3333-4333-8333-333333333333';
    mockCircleUser = {
      id: '111111111111111111111111',
      memberId: '22222222-2222-4222-8222-222222222222',
    };
    const scope = {
      endpoint: 'OpenSchool',
      model: 'circle-a',
      circleId: '44444444-4444-4444-8444-444444444444',
    };
    const release = jest.fn();
    mockCircleRuntime = createCircleExecution({
      enabled: true,
      presence: async () => 'owned',
      report: jest.fn(),
      store: () => ({
        read: async () => ({
          kind: 'bound',
          binding: {
            version: 1,
            key: { chatOwnerId: mockCircleUser.id, conversationId },
            memberId: mockCircleUser.memberId,
            scope,
          },
        }),
        acquire: async () => true,
        release,
      }),
      scope: async () => ({ kind: 'resolved', value: scope }),
    });
    mockIsSubagentThreadWriteBlocked.mockResolvedValue(false);
    db.saveMessage.mockResolvedValue({
      conversationId,
      messageId: 'synthetic',
      endpoint: 'OpenSchool',
      model: 'circle-a',
    });
    db.saveConvo.mockResolvedValue({ conversationId });
    const result = await request(app)
      .post(`/api/messages/${conversationId}`)
      .send({ messageId: 'synthetic', endpoint: 'OpenSchool', model: 'circle-a' });
    expect(result.status).toBe(201);
    expect(db.saveMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ conversationIdFence: conversationId }),
    );
    expect(db.saveConvo).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ noUpsert: true }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('blocks every transcript-affecting message route through one shared policy', async () => {
    const responses = await Promise.all([
      request(app)
        .post('/api/messages/child-conversation')
        .send({ messageId: 'new-message', text: 'write' }),
      request(app)
        .put('/api/messages/child-conversation/message-1')
        .send({ text: 'edit', model: 'gpt-5' }),
      request(app).delete('/api/messages/child-conversation/message-1'),
      request(app).post('/api/messages/branch').send({
        messageId: 'message-1',
        agentId: 'agent-1',
      }),
      request(app).post('/api/messages/artifact/message-1').send({
        index: 0,
        original: 'before',
        updated: 'after',
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([409, 409, 409, 409, 409]);
    for (const response of responses) {
      expect(response.body).toEqual({ error: 'This subagent thread is view-only.' });
    }
    expect(mockIsSubagentThreadWriteBlocked).toHaveBeenCalledTimes(5);
    expect(mockIsSubagentThreadWriteBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ getConvo: expect.any(Function) }),
      {
        userId: 'owner-user',
        conversationId: 'child-conversation',
        tenantId: 'tenant-a',
      },
    );
    expect(db.saveMessage).not.toHaveBeenCalled();
    expect(db.saveConvo).not.toHaveBeenCalled();
    expect(db.updateMessage).not.toHaveBeenCalled();
    expect(db.deleteMessages).not.toHaveBeenCalled();
  });

  it('authorizes edits against the message owner conversation, not a writable URL', async () => {
    mockIsSubagentThreadWriteBlocked.mockResolvedValue(true);
    db.getMessages.mockResolvedValue([
      {
        messageId: 'message-1',
        conversationId: 'child-conversation',
        isCreatedByUser: true,
        content: [],
      },
    ]);

    const response = await request(app)
      .put('/api/messages/ordinary-conversation/message-1')
      .send({ text: 'forged edit', model: 'gpt-5' });

    expect(response.status).toBe(404);
    expect(mockIsSubagentThreadWriteBlocked).not.toHaveBeenCalled();
    expect(db.updateMessage).not.toHaveBeenCalled();
  });
});
