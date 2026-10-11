jest.mock('./defaults', () => ({ FALLBACK_MODEL_BY_ENDPOINT: {} }));
const { createCircleExecution } = require('../../../../packages/api/src/openschool/execution');
let mockRuntime;
jest.mock('~/server/services/CircleExecution', () => ({
  importBatch: (...args) => mockRuntime.importBatch(...args),
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('../../../../packages/api/src/conversations/import'),
  assertConversationImportContentAllowed: jest.fn(),
  assertModelBoundContent: jest.fn(),
  reportLocatorTraversalFailure: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  getTenantId: () => undefined,
  logger: { error: jest.fn(), debug: jest.fn() },
}));
jest.mock('~/models', () => ({
  bulkSaveConvos: jest.fn(),
  bulkSaveMessages: jest.fn(),
  bulkIncrementTagCounts: jest.fn(),
  deleteImportedMessages: jest.fn(),
  deleteImportedConversations: jest.fn(),
  getFiles: jest.fn(),
}));
const db = require('~/models');
const { ImportBatchBuilder } = require('./importBatchBuilder');
const owner = '111111111111111111111111';

describe('circle import persistence boundary', () => {
  let rows, release;
  beforeEach(() => {
    jest.resetAllMocks();
    rows = new Map();
    release = jest.fn(async () => {});
    mockRuntime = createCircleExecution({
      enabled: true,
      presence: async () => 'absent',
      report: jest.fn(),
      store: () => ({
        reserveImport: async (key, operation) => {
          if (rows.has(key.conversationId)) return false;
          rows.set(key.conversationId, { state: 'unbound', operation });
          return true;
        },
        release,
      }),
    });
  });
  function batch() {
    const builder = new ImportBatchBuilder(owner);
    builder.startConversation('OpenSchool');
    builder.addUserMessage('synthetic import');
    builder.finishConversation('synthetic', undefined, {
      circleId: 'browser-forgery',
      user: 'other',
      _id: 'forged',
    });
    return builder;
  }
  test('valid import gets server receipts and remains unbound without inheriting client circle', async () => {
    const builder = batch();
    await builder.saveBatch();
    const id = builder.conversations[0].conversationId;
    expect(rows.get(id).state).toBe('unbound');
    expect(rows.get(id)).not.toHaveProperty('circleId');
    expect(db.bulkSaveConvos).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          user: owner,
          conversationId: id,
          _id: expect.stringMatching(/^[0-9a-f]{24}$/),
        }),
      ],
      true,
    );
    expect(db.bulkSaveMessages).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          conversationId: id,
          _id: expect.stringMatching(/^[0-9a-f]{24}$/),
        }),
      ],
      true,
      true,
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
  test.each(['bound', 'tombstone', 'unbound'])(
    'forced %s collision cannot write or clean existing data',
    async (state) => {
      const builder = batch();
      rows.set(builder.conversations[0].conversationId, { state });
      await expect(builder.saveBatch()).rejects.toThrow();
      expect(db.bulkSaveConvos).not.toHaveBeenCalled();
      expect(db.deleteImportedConversations).not.toHaveBeenCalled();
      expect(db.deleteImportedMessages).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    },
  );
  test.each(['conversation', 'message'])(
    'partial %s failure only cleans exact server receipts',
    async (stage) => {
      const builder = batch();
      (stage === 'conversation' ? db.bulkSaveConvos : db.bulkSaveMessages).mockRejectedValueOnce(
        new Error('ambiguous write'),
      );
      await expect(builder.saveBatch()).rejects.toThrow('ambiguous write');
      const inserted = db.bulkSaveConvos.mock.calls[0][0];
      expect(db.deleteImportedConversations).toHaveBeenCalledWith({
        user: owner,
        conversationIds: [builder.conversationId],
        recordIds: inserted.map((row) => row._id),
      });
      expect(db.deleteImportedMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          user: owner,
          recordIds: [expect.stringMatching(/^[0-9a-f]{24}$/)],
        }),
      );
      expect(db.bulkIncrementTagCounts).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    },
  );
});
