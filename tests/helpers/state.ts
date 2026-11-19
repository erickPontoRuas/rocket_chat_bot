import type { ConversationState, MessageAttachment } from '../../src/conversation/types.js';

export function buildState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    version: 2,
    roomId: 'room-1',
    userId: 'user-1',
    username: 'ana',
    threadId: 'msg-1',
    initialMessage: 'Ao abrir a tela de pedidos recebo um erro.',
    initialAttachments: [],
    status: 'collecting',
    intakeDone: true,
    answers: {},
    questionQueue: [],
    pendingFieldKey: null,
    levelRetryCount: 0,
    lastMessageId: 'msg-1',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function buildAttachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    url: 'https://chat.exemplo.com/file-upload/print.png',
    isImage: true,
    ...overrides,
  };
}
