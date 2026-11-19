import { Redis } from 'ioredis';
import { loadConfig } from './config/env.js';
import { createLogger } from './logger.js';
import { RocketChatClient } from './bot/rocket-chat.client.js';
import { MessageHandler } from './bot/message-handler.js';
import { ConversationService } from './conversation/conversation.service.js';
import { ConversationRepository, RedisConversationStore } from './conversation/state.repository.js';
import { ISSUE_REPORT_FIELDS } from './flows/issue-report.fields.js';
import { OpenAiJsonCompletionClient } from './integrations/ai/openai.completion-client.js';
import { OpenAiIssueAssistant } from './integrations/ai/openai.issue-assistant.js';
import { GitHubIssueCreator } from './integrations/github/github.client.js';
import { RedisLocker } from './utils/lock.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, config.nodeEnv);

  const redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5_000,
  });

  redis.on('error', (error) => {
    logger.error({ err: error }, 'Erro de conexão com o Redis');
  });

  try {
    await redis.ping();
    logger.info('Conexão com o Redis estabelecida');
  } catch (error) {
    logger.fatal({ err: error }, 'Não foi possível conectar ao Redis');
    redis.disconnect();
    throw error;
  }

  const repository = new ConversationRepository(
    new RedisConversationStore(redis),
    config.redis.conversationTtlSeconds,
  );
  const completionClient = new OpenAiJsonCompletionClient({
    apiKey: config.ai.apiKey,
    model: config.ai.model,
    ...(config.ai.baseUrl ? { baseUrl: config.ai.baseUrl } : {}),
    timeoutMs: config.ai.timeoutMs,
  });
  const aiAssistant = new OpenAiIssueAssistant({ completionClient, logger });
  const locker = new RedisLocker(redis);
  const issueCreator = new GitHubIssueCreator({
    token: config.github.token,
    owner: config.github.owner,
    repo: config.github.repo,
    labels: config.github.labels,
    logger,
  });

  let handler: MessageHandler | null = null;

  const rocketChat = new RocketChatClient({
    url: config.rocketChat.url,
    username: config.rocketChat.username,
    password: config.rocketChat.password,
    roomId: config.rocketChat.roomId,
    logger,
    onMessage: async (event) => {
      if (!handler) {
        logger.warn('Mensagem recebida antes da inicialização completa do handler');
        return;
      }

      await handler.handle(event);
    },
  });

  const conversationService = new ConversationService({
    repository,
    analyzer: aiAssistant,
    levelNormalizer: aiAssistant,
    titleGenerator: aiAssistant,
    issueCreator,
    sender: rocketChat,
    locker,
    logger,
    fields: ISSUE_REPORT_FIELDS,
    rocketChatUrl: config.rocketChat.url,
  });

  await rocketChat.start();

  handler = new MessageHandler({
    botUserId: rocketChat.currentUserId,
    roomId: config.rocketChat.roomId,
    rocketChatUrl: config.rocketChat.url,
    service: conversationService,
    repository,
    logger,
  });

  logger.info('Bot iniciado');

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, 'Encerrando o bot');

    try {
      await rocketChat.stop();
    } catch (error) {
      logger.warn({ err: error }, 'Falha ao desconectar do Rocket.Chat');
    }

    try {
      await redis.quit();
    } catch (error) {
      logger.warn({ err: error }, 'Falha ao fechar conexão com o Redis');
    }

    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Promise rejeitada sem tratamento');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Exceção não tratada');
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Falha ao iniciar o bot: ${detail}`);
  process.exitCode = 1;
});
