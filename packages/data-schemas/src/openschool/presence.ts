import type { Connection } from 'mongoose';
import type { BindingKey } from './binding';

/** Only identity existence, never conversation contents. Used before server-created attribution. */
export function createConversationPresence(connection: Connection, tenantId?: string) {
  return async (
    key: BindingKey,
    conversationOnly = false,
  ): Promise<'absent' | 'owned' | 'foreign'> => {
    const options = { projection: { _id: 0, user: 1, tenantId: 1 }, maxTimeMS: 3000 };
    const rows = await Promise.all([
      connection
        .collection('conversations')
        .findOne({ conversationId: key.conversationId }, options),
      conversationOnly
        ? null
        : connection
            .collection('messages')
            .findOne({ conversationId: key.conversationId }, options),
    ]);
    if (
      rows.some(
        (row) =>
          row &&
          (String(row.user) !== key.chatOwnerId || (row.tenantId ?? '') !== (tenantId ?? '')),
      )
    ) {
      return 'foreign';
    }
    return rows.some(Boolean) ? 'owned' : 'absent';
  };
}
