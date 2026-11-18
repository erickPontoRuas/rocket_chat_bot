import type { Logger } from 'pino';
import type { ConversationRepository } from './state.repository.js';
import type {
  ConversationPlanner,
  ConversationState,
  FieldDefinition,
  IncomingMessage,
  IssueCreator,
  MessageProcessor,
  MessageSender,
  PlannerDecision,
} from './types.js';
import type { Locker } from '../utils/lock.js';

const CONVERSATION_LOCK_TTL_MS = 10_000;
const ISSUE_LOCK_TTL_MS = 60_000;

const GENERIC_FAILURE_REPLY =
  'Não consegui processar sua mensagem agora. Tente novamente em instantes.';
const ISSUE_FAILURE_REPLY =
  'Não consegui criar a issue no GitHub. Envie uma nova mensagem para recomeçar o atendimento.';

interface ConversationServiceDependencies {
  repository: ConversationRepository;
  planner: ConversationPlanner;
  issueCreator: IssueCreator;
  sender: MessageSender;
  locker: Locker;
  logger: Logger;
  fields: FieldDefinition[];
  now?: () => Date;
}

export class ConversationService implements MessageProcessor {
  constructor(private readonly deps: ConversationServiceDependencies) {}

  async handleMessage(message: IncomingMessage): Promise<void> {
    const lock = await this.deps.locker.acquire(
      conversationLockKey(message.roomId, message.userId),
      CONVERSATION_LOCK_TTL_MS,
    );

    if (!lock) {
      this.deps.logger.debug(
        { roomId: message.roomId, userId: message.userId },
        'Mensagem ignorada: conversa já está sendo processada',
      );
      return;
    }

    try {
      await this.processMessage(message);
    } catch (error) {
      this.deps.logger.error(
        { err: error, roomId: message.roomId, userId: message.userId },
        'Falha ao processar mensagem',
      );
      await this.notifyFailure(message);
    } finally {
      await lock.release().catch((error: unknown) => {
        this.deps.logger.warn(
          { err: error, roomId: message.roomId, userId: message.userId },
          'Falha ao liberar lock da conversa',
        );
      });
    }
  }

  private async processMessage(message: IncomingMessage): Promise<void> {
    const existingState = await this.deps.repository.get(message.roomId, message.userId);
    const state = existingState ?? this.createState(message);

    if (state.pendingFieldKey) {
      state.answers[state.pendingFieldKey] = message.text;
      state.pendingFieldKey = null;
    }

    if (state.status !== 'collecting') {
      state.status = 'collecting';
      state.error = undefined;
    }

    state.lastMessageId = message.id;
    state.lastActivityAt = this.nowIso();

    await this.deps.repository.save(state);

    const decision = await this.deps.planner.evaluate({
      message: message.text,
      state,
      fields: this.deps.fields,
    });

    switch (decision.type) {
      case 'ask':
        await this.handleAsk(state, decision);
        break;
      case 'create_issue':
        await this.handleCreateIssue(state, decision);
        break;
      case 'ignore':
        this.deps.logger.debug(
          { roomId: state.roomId, userId: state.userId, reason: decision.reason },
          'Mensagem ignorada pelo planner',
        );
        break;
    }
  }

  private async handleAsk(
    state: ConversationState,
    decision: Extract<PlannerDecision, { type: 'ask' }>,
  ): Promise<void> {
    state.pendingFieldKey = decision.fieldKey;

    if (!state.askedFields.includes(decision.fieldKey)) {
      state.askedFields.push(decision.fieldKey);
    }

    state.lastActivityAt = this.nowIso();
    await this.deps.repository.save(state);
    await this.deps.sender.replyInThread(state.roomId, state.threadId, decision.question);
  }

  private async handleCreateIssue(
    state: ConversationState,
    decision: Extract<PlannerDecision, { type: 'create_issue' }>,
  ): Promise<void> {
    state.status = 'creating_issue';
    state.pendingFieldKey = null;
    state.lastActivityAt = this.nowIso();
    await this.deps.repository.save(state);

    const lock = await this.deps.locker.acquire(
      issueLockKey(state.roomId, state.userId),
      ISSUE_LOCK_TTL_MS,
    );

    if (!lock) {
      this.deps.logger.warn(
        { roomId: state.roomId, userId: state.userId },
        'Criação de issue já em andamento',
      );
      return;
    }

    try {
      const issue = await this.deps.issueCreator.createIssue({
        title: decision.title,
        body: decision.body,
      });

      state.status = 'completed';
      state.issueUrl = issue.url;
      state.lastActivityAt = this.nowIso();
      await this.deps.repository.save(state);
      await this.deps.repository.delete(state.roomId, state.userId);

      try {
        await this.deps.sender.replyInThread(
          state.roomId,
          state.threadId,
          `Issue criada com sucesso: ${issue.url}`,
        );
      } catch (sendError) {
        this.deps.logger.error(
          { err: sendError, roomId: state.roomId, userId: state.userId, issueUrl: issue.url },
          'Issue criada, mas falha ao enviar o link na thread',
        );
      }
    } catch (error) {
      this.deps.logger.error(
        { err: error, roomId: state.roomId, userId: state.userId },
        'Falha ao criar issue',
      );

      state.status = 'failed';
      state.error = error instanceof Error ? error.message : String(error);
      state.lastActivityAt = this.nowIso();
      await this.deps.repository.save(state);
      await this.deps.repository.delete(state.roomId, state.userId);

      try {
        await this.deps.sender.replyInThread(state.roomId, state.threadId, ISSUE_FAILURE_REPLY);
      } catch (sendError) {
        this.deps.logger.error(
          { err: sendError, roomId: state.roomId, userId: state.userId },
          'Falha ao enviar aviso de erro de criação de issue',
        );
      }
    } finally {
      await lock.release().catch((error: unknown) => {
        this.deps.logger.warn(
          { err: error, roomId: state.roomId, userId: state.userId },
          'Falha ao liberar lock de criação de issue',
        );
      });
    }
  }

  private async notifyFailure(message: IncomingMessage): Promise<void> {
    try {
      await this.deps.sender.replyInThread(message.roomId, message.threadId, GENERIC_FAILURE_REPLY);
    } catch (error) {
      this.deps.logger.error({ err: error }, 'Falha ao enviar aviso de erro ao usuário');
    }

    try {
      await this.deps.repository.delete(message.roomId, message.userId);
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'Falha ao limpar estado após erro');
    }
  }

  private createState(message: IncomingMessage): ConversationState {
    return {
      version: 1,
      roomId: message.roomId,
      userId: message.userId,
      username: message.username,
      threadId: message.threadId,
      initialMessage: message.text,
      status: 'collecting',
      answers: {},
      askedFields: [],
      pendingFieldKey: null,
      lastMessageId: message.id,
      lastActivityAt: this.nowIso(),
    };
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}

function conversationLockKey(roomId: string, userId: string): string {
  return `lock:conversation:${roomId}:${userId}`;
}

function issueLockKey(roomId: string, userId: string): string {
  return `lock:issue:${roomId}:${userId}`;
}
