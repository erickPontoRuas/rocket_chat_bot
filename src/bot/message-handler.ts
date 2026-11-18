import type { Logger } from 'pino';
import type { RocketChatMessageEvent } from './rocket-chat.client.js';
import type { MessageProcessor } from '../conversation/types.js';
import type { ConversationRepository } from '../conversation/state.repository.js';

interface MessageHandlerDependencies {
  botUserId: string;
  roomId: string;
  service: MessageProcessor;
  repository: ConversationRepository;
  logger: Logger;
}

export class MessageHandler {
  constructor(private readonly deps: MessageHandlerDependencies) {}

  async handle(event: RocketChatMessageEvent): Promise<void> {
    const message = event.message;
    const text = message.msg?.trim();
    const messageId = message._id;
    const roomId = message.rid;
    const userId = message.u?._id;
    const username = message.u?.username;

    if (!messageId || !roomId || !text || !userId || !username) {
      return;
    }

    if (userId === this.deps.botUserId) {
      return;
    }

    if (roomId !== this.deps.roomId) {
      return;
    }

    if (message.t || message.editedAt) {
      return;
    }

    if (await this.deps.repository.isMessageProcessed(messageId)) {
      return;
    }

    if (!(await this.deps.repository.markMessageProcessed(messageId))) {
      return;
    }

    try {
      await this.deps.service.handleMessage({
        id: messageId,
        roomId,
        userId,
        username,
        text,
        threadId: message.tmid?.trim() || messageId,
      });
    } catch (error) {
      this.deps.logger.error({ err: error, messageId, roomId }, 'Falha ao processar mensagem');
    }
  }
}
