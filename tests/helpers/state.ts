import type { ConversationState } from '../../src/conversation/types.js';

export function buildState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    version: 1,
    roomId: 'room-1',
    userId: 'user-1',
    username: 'ana',
    threadId: 'msg-1',
    initialMessage: 'Ao abrir a tela de pedidos recebo um erro.',
    status: 'collecting',
    answers: {},
    askedFields: [],
    pendingFieldKey: null,
    lastMessageId: 'msg-1',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
