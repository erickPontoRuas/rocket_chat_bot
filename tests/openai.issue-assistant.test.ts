import { describe, expect, it } from 'vitest';
import { ISSUE_REPORT_FIELDS } from '../src/flows/issue-report.fields.js';
import { OpenAiIssueAssistant } from '../src/integrations/ai/openai.issue-assistant.js';
import type { JsonCompletionClient } from '../src/integrations/ai/types.js';
import { silentLogger } from './helpers/logger.js';
import { buildAttachment } from './helpers/state.js';

class FakeCompletionClient implements JsonCompletionClient {
  readonly calls: Array<{
    system: string;
    user: string;
    schemaName: string;
    schema: Record<string, unknown>;
  }> = [];

  constructor(private readonly responses: Array<string | Error>) {}

  async complete(input: {
    system: string;
    user: string;
    schemaName: string;
    schema: Record<string, unknown>;
  }): Promise<string> {
    this.calls.push(input);
    const response = this.responses.shift();

    if (response === undefined) {
      throw new Error('Sem resposta simulada');
    }

    if (response instanceof Error) {
      throw response;
    }

    return response;
  }
}

function intakeJson(items: Record<string, { present: boolean; value: string }>): string {
  const complete = Object.fromEntries(
    ISSUE_REPORT_FIELDS.map((field) => [
      field.key,
      items[field.key] ?? { present: false, value: '' },
    ]),
  );

  return JSON.stringify({ items: complete });
}

function createAssistant(client: JsonCompletionClient): OpenAiIssueAssistant {
  return new OpenAiIssueAssistant({ completionClient: client, logger: silentLogger });
}

describe('OpenAiIssueAssistant', () => {
  it('faz parse e sanitização do intake', async () => {
    const client = new FakeCompletionClient([
      intakeJson({
        nivel: { present: true, value: 'perde venda' },
        atendimentoId: { present: true, value: 'ATD-1' },
        clienteDisse: { present: true, value: 'Quero finalizar a compra' },
        print: { present: true, value: 'https://exemplo.com/print.png' },
      }),
    ]);
    const assistant = createAssistant(client);

    const result = await assistant.analyze({
      message: 'Relato',
      attachments: [],
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(result.values.nivel).toBe('PERDE VENDA');
    expect(result.values.atendimentoId).toBe('ATD-1');
    expect(result.values.print).toBe('https://exemplo.com/print.png');
    expect(result.missing).toContain('etapaFunil');
    expect(result.missing).not.toContain('atendimentoId');
    expect(result.missing).not.toContain('print');
    expect(client.calls[0]?.schemaName).toBe('issue_intake');
  });

  it('força print quando há anexo de imagem mesmo que a IA não marque', async () => {
    const client = new FakeCompletionClient([intakeJson({})]);
    const assistant = createAssistant(client);
    const attachment = buildAttachment({
      url: 'https://chat.exemplo.com/file-upload/print.png',
    });

    const result = await assistant.analyze({
      message: '',
      attachments: [attachment],
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(result.values.print).toBe(attachment.url);
    expect(result.missing).not.toContain('print');
  });

  it('remove nível inválido e print sem URL dos itens presentes', async () => {
    const client = new FakeCompletionClient([
      intakeJson({
        nivel: { present: true, value: 'urgente' },
        print: { present: true, value: 'sim' },
        atendimentoId: { present: true, value: 'ATD-1' },
      }),
    ]);
    const assistant = createAssistant(client);

    const result = await assistant.analyze({
      message: 'Relato',
      attachments: [],
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(result.values.nivel).toBeUndefined();
    expect(result.values.print).toBeUndefined();
    expect(result.missing).toContain('nivel');
    expect(result.missing).toContain('print');
  });

  it('normaliza a resposta de nível e trata NENHUM como nulo', async () => {
    const client = new FakeCompletionClient([
      JSON.stringify({ level: 'PERDE VENDA' }),
      JSON.stringify({ level: 'NENHUM' }),
    ]);
    const assistant = createAssistant(client);

    await expect(assistant.normalize({ answer: 'perdi a venda' })).resolves.toBe('PERDE VENDA');
    await expect(assistant.normalize({ answer: 'não se aplica' })).resolves.toBeNull();
  });

  it('limpa e trunca o título gerado', async () => {
    const client = new FakeCompletionClient([
      JSON.stringify({ title: '  "Erro   ao finalizar pedido"  ' }),
      JSON.stringify({ title: 'a'.repeat(100) }),
    ]);
    const assistant = createAssistant(client);

    await expect(
      assistant.generate({
        answers: {},
        fields: ISSUE_REPORT_FIELDS,
        level: 'PERDE VENDA',
      }),
    ).resolves.toBe('Erro ao finalizar pedido');

    const longTitle = await assistant.generate({
      answers: {},
      fields: ISSUE_REPORT_FIELDS,
      level: 'PERDE VENDA',
    });

    expect(longTitle.length).toBeLessThanOrEqual(80);
    expect(longTitle.endsWith('…')).toBe(true);
  });

  it('tenta o intake novamente quando a primeira resposta é inválida', async () => {
    const client = new FakeCompletionClient([
      'não é json',
      intakeJson({ nivel: { present: true, value: 'ATRAPALHA' } }),
    ]);
    const assistant = createAssistant(client);

    const result = await assistant.analyze({
      message: 'Relato',
      attachments: [],
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(client.calls).toHaveLength(2);
    expect(result.values.nivel).toBe('ATRAPALHA');
  });

  it('falha o intake depois de duas respostas inválidas', async () => {
    const client = new FakeCompletionClient(['não é json', 'também não é json']);
    const assistant = createAssistant(client);

    await expect(
      assistant.analyze({
        message: 'Relato',
        attachments: [],
        fields: ISSUE_REPORT_FIELDS,
      }),
    ).rejects.toThrow();
  });
});
