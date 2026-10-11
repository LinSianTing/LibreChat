import { Schema } from 'mongoose';
import type { Connection, PipelineStage } from 'mongoose';

export interface MetadataScope {
  actor: string;
  member: string;
  owner: string;
  circle: string;
  view: 'mine' | 'manager' | 'manager-preview';
  range?: 'all' | '7d';
  since?: string | null;
}
export interface MetadataPosition {
  updatedAt: string;
  id: string;
}
export interface ConversationMetadata extends MetadataPosition {
  title: string;
  createdAt: string;
  savedUserTurns: number;
}
export type MetadataQuery = (
  scope: MetadataScope,
  after?: MetadataPosition,
) => Promise<ConversationMetadata[]>;

/** Positive projections only. No content, text, files, token or cost fields enter the result. */
export function conversationMetadataPipeline(
  namespace: string,
  tenantId: string | undefined,
  scope: MetadataScope,
  after?: MetadataPosition,
): PipelineStage[] {
  const tenant = tenantId ?? { $in: [null, ''] };
  return [
    {
      $match: {
        namespace,
        chatOwnerId: scope.owner,
        memberId: scope.member,
        circleId: scope.circle,
        state: 'bound',
        version: 1,
        endpoint: 'OpenSchool',
      },
    },
    { $project: { _id: 0, conversationId: 1 } },
    {
      $lookup: {
        from: 'conversations',
        let: { id: '$conversationId' },
        pipeline: [
          {
            $match: {
              user: scope.owner,
              tenantId: tenant,
              $expr: { $eq: ['$conversationId', '$$id'] },
            },
          },
          {
            $project: {
              _id: 0,
              id: '$conversationId',
              title: {
                $substrCP: [
                  { $cond: [{ $eq: [{ $type: '$title' }, 'string'] }, '$title', ''] },
                  0,
                  256,
                ],
              },
              createdAt: 1,
              updatedAt: 1,
            },
          },
          { $match: { createdAt: { $type: 'date' }, updatedAt: { $type: 'date' } } },
        ],
        as: 'conversation',
      },
    },
    { $unwind: '$conversation' },
    { $replaceRoot: { newRoot: '$conversation' } },
    ...(scope.range === '7d' ? [{ $match: { updatedAt: { $gte: new Date(scope.since!) } } }] : []),
    ...(after
      ? [
          {
            $match: {
              $or: [
                { updatedAt: { $lt: new Date(after.updatedAt) } },
                { updatedAt: new Date(after.updatedAt), id: { $gt: after.id } },
              ],
            },
          },
        ]
      : []),
    { $sort: { updatedAt: -1, id: 1 } },
    { $limit: 51 },
    {
      $lookup: {
        from: 'messages',
        let: { id: '$id' },
        pipeline: [
          {
            $match: {
              user: scope.owner,
              tenantId: tenant,
              isCreatedByUser: true,
              $expr: { $eq: ['$conversationId', '$$id'] },
            },
          },
          { $project: { _id: 0, messageId: 1 } },
          { $match: { messageId: { $type: 'string', $ne: '' } } },
          { $group: { _id: '$messageId' } },
          { $count: 'count' },
        ],
        as: 'turns',
      },
    },
    {
      $project: {
        _id: 0,
        id: 1,
        title: 1,
        createdAt: 1,
        updatedAt: 1,
        savedUserTurns: { $ifNull: [{ $arrayElemAt: ['$turns.count', 0] }, 0] },
      },
    },
  ];
}

/** Explicit server namespace/tenant, never browser tenant headers or ambient tenant context. */
export function createConversationMetadataQuery(
  connection: Connection,
  options: { namespace?: string; tenantId?: string },
): MetadataQuery {
  const { namespace, tenantId } = options;
  const model =
    connection.models.OpenSchoolMetadataBinding ??
    connection.model(
      'OpenSchoolMetadataBinding',
      new Schema(
        { _id: String },
        { strict: false, autoCreate: false, autoIndex: false, bufferCommands: false },
      ),
      'openschoolbindings',
    );
  return async (scope, after) => {
    const guid =
      /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
    if (
      !namespace ||
      namespace.trim() !== namespace ||
      namespace.length > 200 ||
      connection.readyState !== 1 ||
      (tenantId !== undefined && (!tenantId.trim() || tenantId.trim() !== tenantId)) ||
      !/^[0-9a-f]{24}$/.test(scope.owner) ||
      !guid.test(scope.member) ||
      !guid.test(scope.circle) ||
      !(scope.range === undefined || scope.range === 'all'
        ? scope.since === undefined || scope.since === null
        : scope.range === '7d' &&
          typeof scope.since === 'string' &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(scope.since) &&
          Number.isFinite(Date.parse(scope.since)) &&
          new Date(scope.since).toISOString() === scope.since)
    ) {
      throw new Error('Metadata storage configuration unavailable');
    }
    const rows = await model
      .aggregate<{
        id: string;
        title: string;
        createdAt: Date;
        updatedAt: Date;
        savedUserTurns: number;
      }>(conversationMetadataPipeline(namespace, tenantId, scope, after))
      .read('primary')
      .option({
        maxTimeMS: 5000,
        timeoutMS: 5000,
        allowDiskUse: false,
        collation: { locale: 'simple' },
      })
      .exec();
    return rows.map((row) => {
      // Web's DTO bounds UTF-16 length. Do not leave a split surrogate at the boundary.
      const title = row.title.slice(0, 256).replace(/[\uD800-\uDBFF]$/, '');
      return {
        ...row,
        title,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  };
}
