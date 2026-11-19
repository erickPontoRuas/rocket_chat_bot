import { driver } from '@rocket.chat/sdk';
import type { Logger } from 'pino';
import type { MessageSender } from '../conversation/types.js';

export interface RocketChatAttachment {
  image_url?: string;
  title_link?: string;
  type?: string;
}

export interface RocketChatFile {
  name?: string;
  type?: string;
  url?: string;
}

export interface RocketChatRawMessage {
  _id?: string;
  rid?: string;
  msg?: string;
  tmid?: string;
  t?: string;
  editedAt?: unknown;
  attachments?: RocketChatAttachment[];
  files?: RocketChatFile[];
  file?: RocketChatFile;
  u?: {
    _id?: string;
    username?: string;
  };
}

export interface RocketChatMessageEvent {
  message: RocketChatRawMessage;
  meta: unknown;
}

interface RocketChatClientDependencies {
  url: string;
  username: string;
  password: string;
  roomId: string;
  logger: Logger;
  onMessage: (event: RocketChatMessageEvent) => Promise<void> | void;
}

export class RocketChatClient implements MessageSender {
  private botUserId = '';
  private stopped = false;

  constructor(private readonly deps: RocketChatClientDependencies) {}

  get currentUserId(): string {
    return this.botUserId;
  }

  async start(): Promise<void> {
    const url = new URL(this.deps.url);

    this.configureSdkLogger();

    driver.events.on('connected', () => {
      this.deps.logger.info('Conexão DDP estabelecida com o Rocket.Chat');
    });
    driver.events.on('reconnected', () => {
      this.deps.logger.info('Conexão DDP restabelecida com o Rocket.Chat');
    });

    await driver.connect({
      host: url.host,
      useSsl: url.protocol === 'https:',
      timeout: 30_000,
    });

    const userId = await driver.login({
      username: this.deps.username,
      password: this.deps.password,
    });
    this.botUserId = String(userId);
    this.deps.logger.info({ userId: this.botUserId }, 'Autenticado no Rocket.Chat');

    driver.asteroid.ddp.on('disconnected', () => {
      this.deps.logger.warn('Conexão DDP perdida; o SDK tentará reconectar');
    });

    await driver.joinRoom(this.deps.roomId);
    await driver.subscribeToMessages();

    driver.reactToMessages((error, message, meta) => {
      void this.handleMessageEvent(error, message, meta);
    });

    this.deps.logger.info({ roomId: this.deps.roomId }, 'Escutando mensagens do canal');
  }

  async replyInThread(roomId: string, threadId: string, text: string): Promise<void> {
    const prepared = driver.prepareMessage(text, roomId);
    (prepared as unknown as { tmid?: string }).tmid = threadId;
    await driver.sendMessage(prepared);
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    await driver.disconnect();
  }

  private async handleMessageEvent(
    error: Error | null,
    message: unknown,
    meta: unknown,
  ): Promise<void> {
    if (error) {
      this.deps.logger.error({ err: error }, 'Erro recebido no stream de mensagens');
      return;
    }

    if (!isRocketChatRawMessage(message)) {
      return;
    }

    if (message.u?._id === this.botUserId) {
      return;
    }

    try {
      await this.deps.onMessage({ message, meta });
    } catch (handlerError) {
      this.deps.logger.error({ err: handlerError }, 'Falha ao tratar evento de mensagem');
    }
  }

  private configureSdkLogger(): void {
    const sdkWarn = (...args: unknown[]): void => {
      this.deps.logger.warn({ sdk: args.map(String) }, 'Rocket.Chat SDK');
    };

    driver.useLog({
      debug: () => undefined,
      info: () => undefined,
      warn: sdkWarn,
      warning: sdkWarn,
      error: (...args: unknown[]) => {
        this.deps.logger.error({ sdk: args.map(String) }, 'Rocket.Chat SDK');
      },
    });
  }
}

function isRocketChatRawMessage(value: unknown): value is RocketChatRawMessage {
  return typeof value === 'object' && value !== null && '_id' in value;
}
