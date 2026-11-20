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

function intakeJson(
  items: Record<string, { present: boolean; value: string; evidence?: string }>,
  hasReportContent = true,
): string {
  const complete = Object.fromEntries(
    ISSUE_REPORT_FIELDS.map((field) => {
      const item = items[field.key];

      return [
        field.key,
        {
          present: item?.present ?? false,
          value: item?.value ?? '',
          evidence: item?.evidence ?? '',
        },
      ];
    }),
  );

  return JSON.stringify({ hasReportContent, items: complete });
}

function createAssistant(client: JsonCompletionClient): OpenAiIssueAssistant {
  return new OpenAiIssueAssistant({ completionClient: client, logger: silentLogger });
}

describe('OpenAiIssueAssistant', () => {
  it('faz parse e sanitização do intake', async () => {
    const client = new FakeCompletionClient([
      intakeJson({
        nivel: { present: true, value: 'perde venda', evidence: 'PERDE VENDA' },
        atendimentoId: { present: true, value: 'ATD-1', evidence: 'Atendimento ATD-1' },
        clienteDisse: {
          present: true,
          value: 'Quero finalizar a compra',
          evidence: 'Quero finalizar a compra',
        },
        print: {
          present: true,
          value: 'https://exemplo.com/print.png',
          evidence: 'https://exemplo.com/print.png',
        },
      }),
    ]);
    const assistant = createAssistant(client);

    const result = await assistant.analyze({
      message:
        'Relato PERDE VENDA. Atendimento ATD-1. Quero finalizar a compra. Print: https://exemplo.com/print.png',
      attachments: [],
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(result.values.nivel).toBe('PERDE VENDA');
    expect(result.values.atendimentoId).toBe('ATD-1');
    expect(result.values.clienteDisse).toBe('Quero finalizar a compra');
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
        nivel: { present: true, value: 'urgente', evidence: 'nível urgente' },
        print: { present: true, value: 'sim', evidence: 'Relato com atendimento' },
        atendimentoId: { present: true, value: 'ATD-1', evidence: 'ATD-1' },
      }),
    ]);
    const assistant = createAssistant(client);

    const result = await assistant.analyze({
      message: 'Relato com atendimento ATD-1 e nível urgente',
      attachments: [],
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(result.values.nivel).toBeUndefined();
    expect(result.values.print).toBeUndefined();
    expect(result.values.atendimentoId).toBe('ATD-1');
    expect(result.missing).toContain('nivel');
    expect(result.missing).toContain('print');
  });

  it('trata mensagem sem conteúdo como relato vazio, mesmo com itens marcados pela IA', async () => {
    const echoed = Object.fromEntries(
      ISSUE_REPORT_FIELDS.filter((field) => field.key !== 'nivel' && field.key !== 'print').map(
        (field) => [field.key, { present: true, value: 'teste', evidence: 'teste' }],
      ),
    );
    const client = new FakeCompletionClient([intakeJson(echoed)]);
    const assistant = createAssistant(client);

    const result = await assistant.analyze({
      message: 'teste',
      attachments: [],
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(result.values).toEqual({});
    expect(result.missing).toHaveLength(ISSUE_REPORT_FIELDS.length);
  });

  it('descarta itens quando a IA classifica a mensagem como sem relato', async () => {
    const client = new FakeCompletionClient([
      intakeJson(
        {
          clienteDisse: { present: true, value: 'pediu ajuda', evidence: 'pediu ajuda' },
          atendimentoId: { present: true, value: 'ATD-1', evidence: 'ATD-1' },
        },
        false,
      ),
    ]);
    const assistant = createAssistant(client);

    const result = await assistant.analyze({
      message: 'pediu ajuda ATD-1',
      attachments: [],
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(result.values).toEqual({});
    expect(result.missing).toHaveLength(ISSUE_REPORT_FIELDS.length);
  });

  it('descarta item cuja evidência não está na mensagem', async () => {
    const client = new FakeCompletionClient([
      intakeJson({
        clienteDisse: {
          present: true,
          value: 'Cliente pediu reembolso',
          evidence: 'Cliente pediu reembolso',
        },
      }),
    ]);
    const assistant = createAssistant(client);

    const result = await assistant.analyze({
      message: 'O cliente pediu ajuda com o pedido',
      attachments: [],
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(result.values.clienteDisse).toBeUndefined();
    expect(result.missing).toContain('clienteDisse');
  });

  it('descarta valores repetidos entre campos, mas aceita "não se aplica"', async () => {
    const duplicated = new FakeCompletionClient([
      intakeJson({
        etapaFunil: { present: true, value: 'checkout', evidence: 'checkout' },
        regraNegocio: { present: true, value: 'checkout', evidence: 'checkout' },
      }),
    ]);
    const first = await createAssistant(duplicated).analyze({
      message: 'Problema no checkout durante o pagamento',
      attachments: [],
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(first.values.etapaFunil).toBeUndefined();
    expect(first.values.regraNegocio).toBeUndefined();

    const notApplicable = new FakeCompletionClient([
      intakeJson({
        etapaFunil: { present: true, value: 'não se aplica', evidence: 'não se aplica' },
        regraNegocio: { present: true, value: 'não se aplica', evidence: 'não se aplica' },
      }),
    ]);
    const second = await createAssistant(notApplicable).analyze({
      message: 'Problema no checkout. Não se aplica para etapa e regra.',
      attachments: [],
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(second.values.etapaFunil).toBe('não se aplica');
    expect(second.values.regraNegocio).toBe('não se aplica');
  });

  it('descarta ID de atendimento sem dígitos', async () => {
    const client = new FakeCompletionClient([
      intakeJson({
        atendimentoId: { present: true, value: 'ABC', evidence: 'atendimento ABC' },
      }),
    ]);
    const assistant = createAssistant(client);

    const result = await assistant.analyze({
      message: 'Relato com atendimento ABC e problema no checkout',
      attachments: [],
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(result.values.atendimentoId).toBeUndefined();
    expect(result.missing).toContain('atendimentoId');
  });

  it('descarta URL de print que não existe na mensagem ou nos anexos', async () => {
    const client = new FakeCompletionClient([
      intakeJson({
        print: {
          present: true,
          value: 'https://inventado.com/print.png',
          evidence: 'Relato sem link',
        },
      }),
    ]);
    const assistant = createAssistant(client);

    const result = await assistant.analyze({
      message: 'Relato sem link de imagem',
      attachments: [],
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(result.values.print).toBeUndefined();
    expect(result.missing).toContain('print');
  });

  it('aceita print por URL presente no texto mesmo sem extensão de imagem', async () => {
    const url = 'https://chat.exemplo.com/file/abc123';
    const client = new FakeCompletionClient([
      intakeJson({ print: { present: true, value: url, evidence: url } }),
    ]);
    const assistant = createAssistant(client);

    const result = await assistant.analyze({
      message: `Segue o print: ${url}`,
      attachments: [],
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(result.values.print).toBe(url);
    expect(result.missing).not.toContain('print');
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
      intakeJson({ nivel: { present: true, value: 'ATRAPALHA', evidence: 'ATRAPALHA' } }),
    ]);
    const assistant = createAssistant(client);

    const result = await assistant.analyze({
      message: 'Relato ATRAPALHA',
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
