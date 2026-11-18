import { describe, expect, it } from 'vitest';
import { MessageHandler } from '../src/bot/message-handler.js';
import type {
  RocketChatMessageEvent,
  RocketChatRawMessage,
} from '../src/bot/rocket-chat.client.js';
import { ConversationRepository } from '../src/conversation/state.repository.js';
import type { IncomingMessage, MessageProcessor } from '../src/conversation/types.js';
import { MemoryStore } from './helpers/memory-store.js';
import { silentLogger } from './helpers/logger.js';

class RecordingService implements MessageProcessor {
  readonly messages: IncomingMessage[] = [];

  async handleMessage(message: IncomingMessage): Promise<void> {
    this.messages.push(message);
  }
}

function buildEvent(overrides: Partial<RocketChatRawMessage> = {}): RocketChatMessageEvent {
  return {
    message: {
      _id: 'message-1',
      rid: 'room-1',
      msg: 'Ao abrir a tela de pedidos recebo um erro.',
      u: { _id: 'user-1', username: 'ana' },
      ...overrides,
    },
    meta: { roomType: 'c' },
  };
}

function createHandler(): { handler: MessageHandler; service: RecordingService } {
  const service = new RecordingService();
  const repository = new ConversationRepository(new MemoryStore(), 86400);
  const handler = new MessageHandler({
    botUserId: 'bot-1',
    roomId: 'room-1',
    service,
    repository,
    logger: silentLogger,
  });

  return { handler, service };
}

describe('MessageHandler', () => {
  it('encaminha mensagens válidas do canal', async () => {
    const { handler, service } = createHandler();

    await handler.handle(buildEvent());

    expect(service.messages).toHaveLength(1);
    expect(service.messages[0]).toMatchObject({
      id: 'message-1',
      roomId: 'room-1',
      userId: 'user-1',
      username: 'ana',
      threadId: 'message-1',
    });
  });

  it('usa o tmid como thread da conversa', async () => {
    const { handler, service } = createHandler();

    await handler.handle(buildEvent({ tmid: 'thread-root' }));

    expect(service.messages[0]?.threadId).toBe('thread-root');
  });

  it('não encaminha a mesma mensagem duas vezes', async () => {
    const { handler, service } = createHandler();
    const event = buildEvent();

    await handler.handle(event);
    await handler.handle(event);

    expect(service.messages).toHaveLength(1);
  });

  it('ignora mensagens do próprio bot, de outros canais, de sistema e editadas', async () => {
    const { handler, service } = createHandler();

    await handler.handle(buildEvent({ _id: 'own', u: { _id: 'bot-1', username: 'bot' } }));
    await handler.handle(buildEvent({ _id: 'other-room', rid: 'room-2' }));
    await handler.handle(buildEvent({ _id: 'system', t: 'uj' }));
    await handler.handle(buildEvent({ _id: 'edited', editedAt: '2026-01-01T00:00:00.000Z' }));
    await handler.handle(buildEvent({ _id: 'empty', msg: '   ' }));

    expect(service.messages).toHaveLength(0);
  });
});
