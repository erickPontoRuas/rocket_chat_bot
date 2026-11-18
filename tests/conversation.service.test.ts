import { describe, expect, it } from 'vitest';
import { ConversationService } from '../src/conversation/conversation.service.js';
import { SequentialPlanner } from '../src/conversation/planner/sequential.planner.js';
import { ConversationRepository } from '../src/conversation/state.repository.js';
import type {
  CreatedIssue,
  IncomingMessage,
  IssueCreator,
  MessageSender,
} from '../src/conversation/types.js';
import { ISSUE_REPORT_FIELDS } from '../src/flows/issue-report.fields.js';
import type { LockHandle, Locker } from '../src/utils/lock.js';
import { MemoryStore } from './helpers/memory-store.js';
import { silentLogger } from './helpers/logger.js';

class RecordingSender implements MessageSender {
  readonly replies: Array<{ roomId: string; threadId: string; text: string }> = [];

  async replyInThread(roomId: string, threadId: string, text: string): Promise<void> {
    this.replies.push({ roomId, threadId, text });
  }
}

class RecordingIssueCreator implements IssueCreator {
  readonly calls: Array<{ title: string; body: string }> = [];

  constructor(private readonly outcome: CreatedIssue | Error) {}

  async createIssue(input: { title: string; body: string }): Promise<CreatedIssue> {
    if (this.outcome instanceof Error) {
      throw this.outcome;
    }

    this.calls.push(input);
    return this.outcome;
  }
}

class NoopLocker implements Locker {
  async acquire(): Promise<LockHandle> {
    return { release: async () => undefined };
  }
}

let messageCounter = 0;

function incoming(text: string): IncomingMessage {
  messageCounter += 1;

  return {
    id: `message-${messageCounter}`,
    roomId: 'room-1',
    userId: 'user-1',
    username: 'ana',
    text,
    threadId: 'msg-1',
  };
}

function createService(
  issueOutcome: CreatedIssue | Error = {
    number: 42,
    url: 'https://github.com/acme/repo/issues/42',
  },
) {
  const repository = new ConversationRepository(new MemoryStore(), 86400);
  const sender = new RecordingSender();
  const issueCreator = new RecordingIssueCreator(issueOutcome);
  const service = new ConversationService({
    repository,
    planner: new SequentialPlanner(ISSUE_REPORT_FIELDS, 'https://chat.exemplo.com'),
    issueCreator,
    sender,
    locker: new NoopLocker(),
    logger: silentLogger,
    fields: ISSUE_REPORT_FIELDS,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });

  return { service, repository, sender, issueCreator };
}

const answers = [
  'Erro ao abrir pedidos',
  'Produção, versão 1.2.0, Chrome 120',
  '1. Entrar no sistema\n2. Abrir a tela de pedidos',
  'A tela de pedidos deve abrir',
  'A tela fica em branco',
];

describe('ConversationService', () => {
  it('inicia a conversa e pergunta o primeiro campo faltante', async () => {
    const { service, repository, sender } = createService();

    await service.handleMessage(incoming('Ao abrir a tela de pedidos recebo um erro.'));

    expect(sender.replies).toHaveLength(1);
    expect(sender.replies[0]?.threadId).toBe('msg-1');
    expect(sender.replies[0]?.text).toContain('título');

    const state = await repository.get('room-1', 'user-1');
    expect(state?.initialMessage).toBe('Ao abrir a tela de pedidos recebo um erro.');
    expect(state?.pendingFieldKey).toBe('title');
  });

  it('coleta as respostas, cria a issue e limpa o estado', async () => {
    const { service, repository, sender, issueCreator } = createService();

    await service.handleMessage(incoming('Ao abrir a tela de pedidos recebo um erro.'));

    for (const answer of answers) {
      await service.handleMessage(incoming(answer));
    }

    expect(issueCreator.calls).toHaveLength(1);
    expect(issueCreator.calls[0]?.title).toBe('Erro ao abrir pedidos');
    expect(sender.replies.at(-1)?.text).toContain('https://github.com/acme/repo/issues/42');
    expect(await repository.get('room-1', 'user-1')).toBeNull();
  });

  it('avisa o usuário e limpa o estado quando a criação da issue falha', async () => {
    const { service, repository, sender } = createService(new Error('GitHub indisponível'));

    await service.handleMessage(incoming('Ao abrir a tela de pedidos recebo um erro.'));

    for (const answer of answers) {
      await service.handleMessage(incoming(answer));
    }

    expect(sender.replies.at(-1)?.text).toContain('Não consegui criar a issue');
    expect(await repository.get('room-1', 'user-1')).toBeNull();
  });

  it('ignora uma mensagem enquanto outra da mesma conversa está em processamento', async () => {
    const repository = new ConversationRepository(new MemoryStore(), 86400);
    const sender = new RecordingSender();
    const issueCreator = new RecordingIssueCreator({
      number: 1,
      url: 'https://github.com/acme/repo/issues/1',
    });
    const blockedLocker = {
      acquire: async (): Promise<null> => null,
    };
    const service = new ConversationService({
      repository,
      planner: new SequentialPlanner(ISSUE_REPORT_FIELDS, 'https://chat.exemplo.com'),
      issueCreator,
      sender,
      locker: blockedLocker,
      logger: silentLogger,
      fields: ISSUE_REPORT_FIELDS,
    });

    await service.handleMessage(incoming('Mensagem concorrente'));

    expect(sender.replies).toHaveLength(0);
    expect(await repository.get('room-1', 'user-1')).toBeNull();
  });
});
