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
    rocketChatUrl: 'https://chat.exemplo.com',
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

  it('encaminha mensagem somente com anexo de imagem', async () => {
    const { handler, service } = createHandler();

    await handler.handle(
      buildEvent({
        _id: 'attachment-only',
        msg: '',
        attachments: [{ image_url: '/file-upload/print.png' }],
      }),
    );

    expect(service.messages).toHaveLength(1);
    expect(service.messages[0]?.text).toBe('');
    expect(service.messages[0]?.attachments).toEqual([
      { url: 'https://chat.exemplo.com/file-upload/print.png', isImage: true },
    ]);
  });

  it('respeita URLs absolutas e converte URLs relativas de anexos', async () => {
    const { handler, service } = createHandler();

    await handler.handle(
      buildEvent({
        _id: 'absolute',
        attachments: [{ image_url: 'https://cdn.exemplo.com/print.jpg' }],
        files: [{ name: 'screenshot', type: 'image/png', url: '/file-upload/screenshot' }],
      }),
    );

    expect(service.messages[0]?.attachments).toEqual([
      { url: 'https://cdn.exemplo.com/print.jpg', isImage: true },
      {
        url: 'https://chat.exemplo.com/file-upload/screenshot',
        name: 'screenshot',
        mimeType: 'image/png',
        isImage: true,
      },
    ]);
  });

  it('marca anexos que não são imagem sem tratá-los como print', async () => {
    const { handler, service } = createHandler();

    await handler.handle(
      buildEvent({
        _id: 'log-file',
        msg: '',
        files: [{ name: 'log.txt', type: 'text/plain', url: '/file-upload/log.txt' }],
      }),
    );

    expect(service.messages[0]?.attachments).toEqual([
      {
        url: 'https://chat.exemplo.com/file-upload/log.txt',
        name: 'log.txt',
        mimeType: 'text/plain',
        isImage: false,
      },
    ]);
  });
});
