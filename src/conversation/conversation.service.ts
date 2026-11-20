import type { Logger } from 'pino';
import type { ConversationRepository } from './state.repository.js';
import type {
  ConversationState,
  FieldDefinition,
  IncomingMessage,
  IssueCreator,
  MessageProcessor,
  MessageSender,
} from './types.js';
import type { Locker } from '../utils/lock.js';
import type { IssueLevel } from '../flows/issue-report.fields.js';
import { isIssueLevel } from '../flows/issue-report.fields.js';
import { buildIssueContent } from '../integrations/github/issue.builder.js';
import type {
  LevelNormalizer,
  ReportAnalyzer,
  ReportIntake,
  TitleGenerator,
} from '../integrations/ai/types.js';

const CONVERSATION_LOCK_TTL_MS = 120_000;
const ISSUE_LOCK_TTL_MS = 120_000;

const GENERIC_FAILURE_REPLY =
  'Não consegui processar sua mensagem agora. Tente novamente em instantes.';
const ISSUE_FAILURE_REPLY =
  'Não consegui criar a issue no GitHub. Envie uma nova mensagem para recomeçar o atendimento.';
const AI_ANALYSIS_FAILURE_NOTE =
  'Não consegui analisar sua mensagem automaticamente. Vou perguntar os itens um a um.';
const INVALID_LEVEL_REPLY =
  'Não consegui identificar o nível. Responda com **ATRAPALHA** ou **PERDE VENDA**.';

interface ConversationServiceDependencies {
  repository: ConversationRepository;
  analyzer: ReportAnalyzer;
  levelNormalizer: LevelNormalizer;
  titleGenerator: TitleGenerator;
  issueCreator: IssueCreator;
  sender: MessageSender;
  locker: Locker;
  logger: Logger;
  fields: FieldDefinition[];
  rocketChatUrl: string;
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

    if (!existingState) {
      await this.startConversation(message);
      return;
    }

    if (!existingState.intakeDone) {
      await this.runIntake(
        existingState,
        existingState.initialMessage,
        existingState.initialAttachments,
      );
      return;
    }

    if (existingState.status !== 'collecting') {
      existingState.status = 'collecting';
      existingState.error = undefined;
    }

    if (!existingState.pendingFieldKey) {
      existingState.lastMessageId = message.id;
      existingState.lastActivityAt = this.nowIso();
      await this.deps.repository.save(existingState);

      if (existingState.questionQueue.length === 0) {
        await this.finalize(existingState);
        return;
      }

      await this.askNext(existingState);
      return;
    }

    await this.recordAnswer(existingState, message);
  }

  private async startConversation(message: IncomingMessage): Promise<void> {
    const state = this.createState(message);
    await this.runIntake(state, message.text, message.attachments);
  }

  private async runIntake(
    state: ConversationState,
    message: string,
    attachments: ConversationState['initialAttachments'],
  ): Promise<void> {
    let intake: ReportIntake;
    let analysisFailed = false;

    try {
      intake = await this.deps.analyzer.analyze({
        message,
        attachments,
        fields: this.deps.fields,
      });
    } catch (error) {
      analysisFailed = true;
      this.deps.logger.error(
        { err: error, roomId: state.roomId, userId: state.userId },
        'Falha ao avaliar o relato com a IA; usando fila completa',
      );
      intake = { values: {}, missing: this.deps.fields.map((field) => field.key) };
    }

    state.answers = intake.values;
    state.questionQueue = this.normalizeQueue(state);
    state.intakeDone = true;
    state.pendingFieldKey = null;
    state.lastActivityAt = this.nowIso();

    if (intake.missing.join(',') !== state.questionQueue.join(',')) {
      this.deps.logger.warn(
        {
          roomId: state.roomId,
          userId: state.userId,
          reportedMissing: intake.missing,
          computedMissing: state.questionQueue,
        },
        'Fila de perguntas divergiu da avaliação da IA; usando itens sem resposta',
      );
    }

    await this.deps.repository.save(state);

    this.deps.logger.info(
      {
        roomId: state.roomId,
        userId: state.userId,
        present: Object.keys(intake.values).length,
        missing: state.questionQueue.length,
        analysisFailed,
      },
      'Relato avaliado pela IA',
    );

    if (state.questionQueue.length === 0) {
      await this.finalize(state);
      return;
    }

    const summary = this.buildIntakeSummary(state.questionQueue);
    const intro = analysisFailed ? `${AI_ANALYSIS_FAILURE_NOTE}\n\n${summary}` : summary;
    await this.askNext(state, intro);
  }

  private async askNext(state: ConversationState, intro?: string): Promise<void> {
    const key = state.questionQueue[0];
    const field = key ? this.fieldByKey(key) : undefined;

    if (!key || !field) {
      this.deps.logger.error(
        { roomId: state.roomId, userId: state.userId, key },
        'Fila de perguntas inválida; finalizando',
      );
      await this.finalize(state);
      return;
    }

    state.pendingFieldKey = key;
    state.lastActivityAt = this.nowIso();
    await this.deps.repository.save(state);

    const text = intro ? `${intro}\n\n${field.question}` : field.question;
    await this.send(state, text);
  }

  private async recordAnswer(state: ConversationState, message: IncomingMessage): Promise<void> {
    const key = state.pendingFieldKey;

    if (!key) {
      return;
    }

    const field = this.fieldByKey(key);

    if (!field) {
      state.pendingFieldKey = null;
      state.lastActivityAt = this.nowIso();
      await this.deps.repository.save(state);
      await this.askNext(state);
      return;
    }

    const value = formatMessageValue(message);

    if (key === 'nivel') {
      const normalized = await this.deps.levelNormalizer.normalize({ answer: value });

      if (normalized) {
        state.answers[key] = normalized;
      } else if (state.levelRetryCount < 1) {
        state.levelRetryCount += 1;
        state.lastMessageId = message.id;
        state.lastActivityAt = this.nowIso();
        await this.deps.repository.save(state);
        await this.send(state, INVALID_LEVEL_REPLY);
        return;
      } else {
        state.answers[key] = 'ATRAPALHA';
        this.deps.logger.warn(
          { roomId: state.roomId, userId: state.userId, answerLength: value.length },
          'Nível inválido após repergunta; usando ATRAPALHA',
        );
      }
    } else {
      state.answers[key] = value;
    }

    state.questionQueue = state.questionQueue.filter((queuedKey) => queuedKey !== key);
    state.pendingFieldKey = null;
    state.lastMessageId = message.id;
    state.lastActivityAt = this.nowIso();
    await this.deps.repository.save(state);

    if (state.questionQueue.length === 0) {
      await this.finalize(state);
      return;
    }

    await this.askNext(state);
  }

  private async finalize(state: ConversationState): Promise<void> {
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
      const level = this.resolveLevel(state);
      const title = await this.generateTitle(state, level);
      const content = buildIssueContent({
        state,
        fields: this.deps.fields,
        rocketChatUrl: this.deps.rocketChatUrl,
        level,
        title,
      });

      const issue = await this.deps.issueCreator.createIssue({
        title: content.title,
        body: content.body,
        labels: content.labels,
      });

      state.status = 'completed';
      state.issueNumber = issue.number;
      state.issueUrl = issue.url;
      state.issueTitle = content.title;
      state.lastActivityAt = this.nowIso();
      await this.deps.repository.save(state);
      await this.deps.repository.delete(state.roomId, state.userId);

      try {
        await this.send(
          state,
          buildCompletionMessage(state, content.title, issue.number, issue.url, level),
        );
      } catch (sendError) {
        this.deps.logger.error(
          { err: sendError, roomId: state.roomId, userId: state.userId, issueUrl: issue.url },
          'Issue criada, mas falha ao enviar a confirmação no canal',
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
        await this.send(state, ISSUE_FAILURE_REPLY);
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

  private async generateTitle(state: ConversationState, level: IssueLevel): Promise<string> {
    try {
      return await this.deps.titleGenerator.generate({
        answers: state.answers,
        fields: this.deps.fields,
        level,
      });
    } catch (error) {
      this.deps.logger.warn(
        { err: error, roomId: state.roomId, userId: state.userId },
        'Falha ao gerar título com IA; usando fallback',
      );
      return '';
    }
  }

  private resolveLevel(state: ConversationState): IssueLevel {
    const value = state.answers.nivel?.trim().toUpperCase();

    if (value && isIssueLevel(value)) {
      return value;
    }

    this.deps.logger.warn(
      { roomId: state.roomId, userId: state.userId },
      'Nível ausente ou inválido na finalização; usando ATRAPALHA',
    );

    return 'ATRAPALHA';
  }

  private normalizeQueue(state: ConversationState): string[] {
    return this.deps.fields
      .filter((field) => !state.answers[field.key]?.trim())
      .map((field) => field.key);
  }

  private buildIntakeSummary(keys: string[]): string {
    const labels = keys.map((key) => this.fieldByKey(key)?.label ?? key);

    return [
      'Recebi seu relato. Para abrir a issue, ainda preciso de:',
      ...labels.map((label) => `- ${label}`),
      '',
      'Você pode responder "não se aplica" quando não houver informação (exceto para o nível).',
    ].join('\n');
  }

  private fieldByKey(key: string): FieldDefinition | undefined {
    return this.deps.fields.find((field) => field.key === key);
  }

  private async send(state: ConversationState, text: string): Promise<void> {
    await this.deps.sender.reply(state.roomId, `@${state.username} ${text}`);
  }

  private async notifyFailure(message: IncomingMessage): Promise<void> {
    try {
      await this.deps.sender.reply(message.roomId, `@${message.username} ${GENERIC_FAILURE_REPLY}`);
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
      version: 3,
      roomId: message.roomId,
      userId: message.userId,
      username: message.username,
      initialMessageId: message.id,
      initialMessage: message.text,
      initialAttachments: message.attachments,
      status: 'collecting',
      intakeDone: false,
      answers: {},
      questionQueue: [],
      pendingFieldKey: null,
      levelRetryCount: 0,
      lastMessageId: message.id,
      lastActivityAt: this.nowIso(),
    };
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}

function formatMessageValue(message: IncomingMessage): string {
  const parts: string[] = [];
  const text = message.text.trim();

  if (text) {
    parts.push(text);
  }

  for (const attachment of message.attachments) {
    parts.push(attachment.url);
  }

  return parts.join('\n');
}

function buildCompletionMessage(
  state: ConversationState,
  title: string,
  number: number,
  url: string,
  level: IssueLevel,
): string {
  const atendimentoId = state.answers.atendimentoId?.trim();

  return [
    `Issue criada: #${number} — ${title}`,
    `Nível: ${level}`,
    `Atendimento: ${atendimentoId || 'não informado'}`,
    `Link: ${url}`,
  ].join('\n');
}

function conversationLockKey(roomId: string, userId: string): string {
  return `lock:conversation:${roomId}:${userId}`;
}

function issueLockKey(roomId: string, userId: string): string {
  return `lock:issue:${roomId}:${userId}`;
}
