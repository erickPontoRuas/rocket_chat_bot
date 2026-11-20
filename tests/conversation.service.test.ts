import { describe, expect, it } from 'vitest';
import { ConversationService } from '../src/conversation/conversation.service.js';
import { ConversationRepository } from '../src/conversation/state.repository.js';
import type {
  CreatedIssue,
  IncomingMessage,
  IssueCreator,
  MessageAttachment,
  MessageSender,
} from '../src/conversation/types.js';
import { ISSUE_REPORT_FIELDS } from '../src/flows/issue-report.fields.js';
import type { IssueLevel } from '../src/flows/issue-report.fields.js';
import type { ReportAnalyzer, TitleGenerator } from '../src/integrations/ai/types.js';
import type { LockHandle, Locker } from '../src/utils/lock.js';
import {
  ALL_ANSWERS,
  FakeAnalyzer,
  FakeLevelNormalizer,
  FakeTitleGenerator,
  intakeFor,
} from './helpers/ai.js';
import { silentLogger } from './helpers/logger.js';
import { MemoryStore } from './helpers/memory-store.js';
import { buildAttachment, buildState } from './helpers/state.js';

class RecordingSender implements MessageSender {
  readonly replies: Array<{ roomId: string; text: string }> = [];

  async reply(roomId: string, text: string): Promise<void> {
    this.replies.push({ roomId, text });
  }
}

class RecordingIssueCreator implements IssueCreator {
  readonly calls: Array<{ title: string; body: string; labels?: string[] }> = [];

  constructor(private readonly outcome: CreatedIssue | Error) {}

  async createIssue(input: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<CreatedIssue> {
    this.calls.push(input);

    if (this.outcome instanceof Error) {
      throw this.outcome;
    }

    return this.outcome;
  }
}

class NoopLocker implements Locker {
  async acquire(): Promise<LockHandle> {
    return { release: async () => undefined };
  }
}

interface CreateServiceOptions {
  analyze?: ReportAnalyzer['analyze'];
  normalize?: (answer: string) => Promise<IssueLevel | null>;
  generateTitle?: TitleGenerator['generate'];
  issueOutcome?: CreatedIssue | Error;
  locker?: Locker;
}

let messageCounter = 0;

function incoming(text: string, attachments: MessageAttachment[] = []): IncomingMessage {
  messageCounter += 1;

  return {
    id: `message-${messageCounter}`,
    roomId: 'room-1',
    userId: 'user-1',
    username: 'ana',
    text,
    attachments,
  };
}

function createService(options: CreateServiceOptions = {}) {
  const repository = new ConversationRepository(new MemoryStore(), 86400);
  const sender = new RecordingSender();
  const issueCreator = new RecordingIssueCreator(
    options.issueOutcome ?? {
      number: 42,
      url: 'https://github.com/acme/repo/issues/42',
    },
  );
  const analyzer = new FakeAnalyzer(options.analyze ?? (async () => intakeFor(ALL_ANSWERS)));
  const levelNormalizer = new FakeLevelNormalizer(
    options.normalize ??
      (async (answer) => {
        const normalized = answer.trim().toUpperCase();

        if (normalized === 'ATRAPALHA' || normalized === 'PERDE VENDA') {
          return normalized;
        }

        return null;
      }),
  );
  const titleGenerator = new FakeTitleGenerator(
    options.generateTitle ?? (async () => 'Erro ao finalizar pedido'),
  );
  const service = new ConversationService({
    repository,
    analyzer,
    levelNormalizer,
    titleGenerator,
    issueCreator,
    sender,
    locker: options.locker ?? new NoopLocker(),
    logger: silentLogger,
    fields: ISSUE_REPORT_FIELDS,
    rocketChatUrl: 'https://chat.exemplo.com',
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });

  return { service, repository, sender, issueCreator, analyzer, levelNormalizer, titleGenerator };
}

describe('ConversationService', () => {
  it('avalia a primeira mensagem, lista os faltantes e pergunta o primeiro item', async () => {
    const { service, repository, sender } = createService({
      analyze: async () => intakeFor({ nivel: 'PERDE VENDA' }),
    });

    await service.handleMessage(
      incoming('Cliente perdeu a venda porque o bot não concluiu o pedido.'),
    );

    expect(sender.replies).toHaveLength(1);
    const text = sender.replies[0]?.text ?? '';
    expect(text.startsWith('@ana ')).toBe(true);
    expect(text).toContain('Recebi seu relato');
    expect(text).toContain('- ID do atendimento');
    expect(text).toContain('não se aplica');
    expect(text).toContain('Qual é o ID do atendimento?');

    const state = await repository.get('room-1', 'user-1');
    expect(state?.intakeDone).toBe(true);
    expect(state?.pendingFieldKey).toBe('atendimentoId');
    expect(state?.answers.nivel).toBe('PERDE VENDA');
    expect(state?.questionQueue).toHaveLength(8);
  });

  it('pergunta todos os campos sem resposta mesmo quando a IA informa faltantes incompletos', async () => {
    const { service, repository, sender } = createService({
      analyze: async () => ({ values: { nivel: 'PERDE VENDA' }, missing: [] }),
    });

    await service.handleMessage(incoming('teste'));

    const text = sender.replies[0]?.text ?? '';
    expect(text).toContain('Recebi seu relato');
    expect(text).toContain('- ID do atendimento');
    expect(text).toContain('- Print');
    expect(text).toContain('Qual é o ID do atendimento?');

    const state = await repository.get('room-1', 'user-1');
    expect(state?.answers).toEqual({ nivel: 'PERDE VENDA' });
    expect(state?.questionQueue).toHaveLength(8);
    expect(state?.pendingFieldKey).toBe('atendimentoId');
  });

  it('cria a issue direto quando todos os itens estão presentes', async () => {
    const { service, repository, sender, issueCreator, analyzer } = createService();

    await service.handleMessage(incoming('Relato completo'));

    expect(analyzer.calls).toHaveLength(1);
    expect(issueCreator.calls).toHaveLength(1);
    expect(issueCreator.calls[0]?.title).toBe('#ATD-1 - Erro ao finalizar pedido');
    expect(issueCreator.calls[0]?.title).not.toContain('PERDE VENDA');
    expect(issueCreator.calls[0]?.labels).toEqual(['PERDE VENDA']);
    expect(issueCreator.calls[0]?.body).toContain('## Nível\n\nPERDE VENDA');
    expect(issueCreator.calls[0]?.body).toContain('## Regra de negócio\n\nPriorizar a venda');

    const completion = sender.replies.at(-1)?.text ?? '';
    expect(completion.startsWith('@ana ')).toBe(true);
    expect(completion).toContain('#42');
    expect(completion).toContain('#ATD-1 - Erro ao finalizar pedido');
    expect(completion).toContain('Nível: PERDE VENDA');
    expect(completion).toContain('Atendimento: ATD-1');
    expect(completion).toContain('https://github.com/acme/repo/issues/42');
    expect(await repository.get('room-1', 'user-1')).toBeNull();
  });

  it('pergunta um item por vez e cria a issue ao final da fila', async () => {
    const { service, repository, sender, issueCreator } = createService({
      analyze: async () => intakeFor({ nivel: 'PERDE VENDA' }),
    });

    await service.handleMessage(incoming('Cliente perdeu a venda.'));
    expect(sender.replies[0]?.text).toContain('Qual é o ID do atendimento?');

    const missingKeys = ISSUE_REPORT_FIELDS.filter((field) => field.key !== 'nivel').map(
      (field) => field.key,
    );
    const answers = [
      'ATD-77',
      'Checkout',
      'Cliente pediu para finalizar',
      'Bot respondeu sem estoque',
      'Deveria concluir a compra',
      'Priorizar venda',
      'Não',
      'https://chat.exemplo.com/file-upload/print.png',
    ];

    for (let index = 0; index < answers.length; index += 1) {
      const answer = answers[index];

      if (answer === undefined) {
        throw new Error('Resposta de teste ausente');
      }

      await service.handleMessage(incoming(answer));

      if (index < answers.length - 1) {
        const state = await repository.get('room-1', 'user-1');
        expect(state?.pendingFieldKey).toBe(missingKeys[index + 1]);
      }
    }

    expect(issueCreator.calls).toHaveLength(1);
    const body = issueCreator.calls[0]?.body ?? '';
    expect(body).toContain('## Etapa do funil\n\nCheckout');
    expect(body).toContain('## Print\n\nhttps://chat.exemplo.com/file-upload/print.png');
    expect(sender.replies.at(-1)?.text).toContain('#42');
    expect(await repository.get('room-1', 'user-1')).toBeNull();
  });

  it('grava "não se aplica" literalmente e segue para o próximo item', async () => {
    const { service, repository, sender } = createService({
      analyze: async () => intakeFor({ nivel: 'ATRAPALHA', atendimentoId: 'ATD-9' }),
    });

    await service.handleMessage(incoming('Relato'));
    expect(sender.replies[0]?.text).toContain('Em qual etapa do funil');

    await service.handleMessage(incoming('não se aplica'));

    const state = await repository.get('room-1', 'user-1');
    expect(state?.answers.etapaFunil).toBe('não se aplica');
    expect(state?.pendingFieldKey).toBe('clienteDisse');
    expect(sender.replies.at(-1)?.text).toContain('O que o cliente disse ou pediu?');
  });

  it('usa a URL do anexo como resposta do print', async () => {
    const present = { ...ALL_ANSWERS };
    delete present.print;

    const { service, issueCreator, sender } = createService({
      analyze: async () => intakeFor(present),
    });

    await service.handleMessage(incoming('Relato sem print'));
    expect(sender.replies[0]?.text).toContain('Envie o print');

    const attachment = buildAttachment({
      url: 'https://chat.exemplo.com/file-upload/print-1.png',
    });
    await service.handleMessage(incoming('', [attachment]));

    expect(issueCreator.calls[0]?.body).toContain(
      'https://chat.exemplo.com/file-upload/print-1.png',
    );
  });

  it('repergunta o nível uma vez e usa ATRAPALHA se continuar inválido', async () => {
    const present = { ...ALL_ANSWERS };
    delete present.nivel;

    const { service, issueCreator, sender, levelNormalizer } = createService({
      analyze: async () => intakeFor(present),
      normalize: async () => null,
    });

    await service.handleMessage(incoming('Relato sem nível'));
    expect(sender.replies[0]?.text).toContain('Qual é o nível');

    await service.handleMessage(incoming('urgente'));
    const invalidLevelReply = sender.replies.at(-1)?.text ?? '';
    expect(invalidLevelReply.startsWith('@ana ')).toBe(true);
    expect(invalidLevelReply).toContain('ATRAPALHA');
    expect(invalidLevelReply).toContain('PERDE VENDA');

    await service.handleMessage(incoming('não sei'));

    expect(levelNormalizer.calls).toHaveLength(2);
    expect(issueCreator.calls).toHaveLength(1);
    expect(issueCreator.calls[0]?.labels).toEqual(['ATRAPALHA']);
    expect(issueCreator.calls[0]?.title.startsWith('ATRAPALHA')).toBe(false);
    expect(issueCreator.calls[0]?.title).toBe('#ATD-1 - Erro ao finalizar pedido');
  });

  it('usa a fila completa quando a IA falha na avaliação inicial', async () => {
    const { service, repository, sender } = createService({
      analyze: async () => {
        throw new Error('IA indisponível');
      },
    });

    await service.handleMessage(incoming('Relato'));

    const text = sender.replies[0]?.text ?? '';
    expect(text).toContain('Não consegui analisar sua mensagem automaticamente');
    expect(text).toContain('- Nível');
    expect(text).toContain('Qual é o nível');

    const state = await repository.get('room-1', 'user-1');
    expect(state?.intakeDone).toBe(true);
    expect(state?.questionQueue).toHaveLength(9);
    expect(state?.pendingFieldKey).toBe('nivel');
  });

  it('avisa o usuário e limpa o estado quando a criação da issue falha', async () => {
    const { service, repository, sender, issueCreator } = createService({
      issueOutcome: new Error('GitHub indisponível'),
    });

    await service.handleMessage(incoming('Relato completo'));

    expect(issueCreator.calls).toHaveLength(1);
    const failureReply = sender.replies.at(-1)?.text ?? '';
    expect(failureReply.startsWith('@ana ')).toBe(true);
    expect(failureReply).toContain('Não consegui criar a issue');
    expect(await repository.get('room-1', 'user-1')).toBeNull();
  });

  it('recupera um estado com fila pendente e pergunta o próximo item', async () => {
    const { service, repository, sender } = createService();

    await repository.save(
      buildState({
        answers: { nivel: 'PERDE VENDA' },
        questionQueue: ['atendimentoId'],
        pendingFieldKey: null,
      }),
    );

    await service.handleMessage(incoming('texto que não deve ser consumido'));

    expect(sender.replies[0]?.text).toContain('Qual é o ID do atendimento?');

    const state = await repository.get('room-1', 'user-1');
    expect(state?.answers.atendimentoId).toBeUndefined();
    expect(state?.pendingFieldKey).toBe('atendimentoId');
  });

  it('ignora uma mensagem enquanto outra da mesma conversa está em processamento', async () => {
    const blockedLocker = {
      acquire: async (): Promise<null> => null,
    };
    const { service, repository, sender } = createService({ locker: blockedLocker });

    await service.handleMessage(incoming('Mensagem concorrente'));

    expect(sender.replies).toHaveLength(0);
    expect(await repository.get('room-1', 'user-1')).toBeNull();
  });
});
