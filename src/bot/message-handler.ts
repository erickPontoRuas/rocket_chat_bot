import type { Logger } from 'pino';
import type { RocketChatMessageEvent, RocketChatRawMessage } from './rocket-chat.client.js';
import type { MessageAttachment, MessageProcessor } from '../conversation/types.js';
import type { ConversationRepository } from '../conversation/state.repository.js';

interface MessageHandlerDependencies {
  botUserId: string;
  roomId: string;
  rocketChatUrl: string;
  service: MessageProcessor;
  repository: ConversationRepository;
  logger: Logger;
}

const IMAGE_EXTENSION_REGEX = /\.(?:png|jpe?g|gif|webp|bmp)(?:[?#].*)?$/i;

export class MessageHandler {
  constructor(private readonly deps: MessageHandlerDependencies) {}

  async handle(event: RocketChatMessageEvent): Promise<void> {
    const message = event.message;
    const text = message.msg?.trim() ?? '';
    const messageId = message._id;
    const roomId = message.rid;
    const userId = message.u?._id;
    const username = message.u?.username;
    const attachments = extractAttachments(message, this.deps.rocketChatUrl);

    if (!messageId || !roomId || (!text && attachments.length === 0) || !userId || !username) {
      return;
    }

    if (userId === this.deps.botUserId) {
      return;
    }

    if (roomId !== this.deps.roomId) {
      return;
    }

    if (message.editedAt) {
      return;
    }

    if (message.t && attachments.length === 0) {
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
        attachments,
        threadId: message.tmid?.trim() || messageId,
      });
    } catch (error) {
      this.deps.logger.error({ err: error, messageId, roomId }, 'Falha ao processar mensagem');
    }
  }
}

function extractAttachments(
  message: RocketChatRawMessage,
  rocketChatUrl: string,
): MessageAttachment[] {
  const candidates: MessageAttachment[] = [];

  for (const attachment of message.attachments ?? []) {
    if (attachment.image_url) {
      const url = resolveUrl(attachment.image_url, rocketChatUrl);

      if (url) {
        candidates.push({ url, isImage: true });
      }
    }

    if (attachment.title_link && isImageReference(attachment.title_link, attachment.type)) {
      const url = resolveUrl(attachment.title_link, rocketChatUrl);

      if (url) {
        candidates.push({ url, isImage: true });
      }
    }
  }

  const files = [...(message.files ?? []), ...(message.file ? [message.file] : [])];

  for (const file of files) {
    if (!file.url) {
      continue;
    }

    const url = resolveUrl(file.url, rocketChatUrl);

    if (!url) {
      continue;
    }

    candidates.push({
      url,
      ...(file.name ? { name: file.name } : {}),
      ...(file.type ? { mimeType: file.type } : {}),
      isImage: isImageReference(file.name ?? file.url, file.type),
    });
  }

  return dedupeAttachments(candidates);
}

function isImageReference(value: string, mimeType?: string): boolean {
  const normalized = mimeType?.toLowerCase();

  if (normalized === 'image' || normalized?.startsWith('image/')) {
    return true;
  }

  return IMAGE_EXTENSION_REGEX.test(value);
}

function resolveUrl(value: string, rocketChatUrl: string): string | null {
  try {
    const base = `${rocketChatUrl.replace(/\/+$/, '')}/`;
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

function dedupeAttachments(attachments: MessageAttachment[]): MessageAttachment[] {
  const byUrl = new Map<string, MessageAttachment>();

  for (const attachment of attachments) {
    const existing = byUrl.get(attachment.url);

    if (!existing) {
      byUrl.set(attachment.url, { ...attachment });
      continue;
    }

    existing.isImage = existing.isImage || attachment.isImage;
    existing.name ??= attachment.name;
    existing.mimeType ??= attachment.mimeType;
  }

  return [...byUrl.values()];
}
