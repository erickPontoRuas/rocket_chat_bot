import { describe, expect, it } from 'vitest';
import { SequentialPlanner } from '../src/conversation/planner/sequential.planner.js';
import { ISSUE_REPORT_FIELDS } from '../src/flows/issue-report.fields.js';
import { buildState } from './helpers/state.js';

const planner = new SequentialPlanner(ISSUE_REPORT_FIELDS, 'https://chat.exemplo.com');

describe('SequentialPlanner', () => {
  it('pergunta o título depois da mensagem inicial', async () => {
    const decision = await planner.evaluate({
      message: 'Ao abrir a tela de pedidos recebo um erro.',
      state: buildState(),
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(decision.type).toBe('ask');

    if (decision.type !== 'ask') {
      throw new Error('Decisão inesperada');
    }

    expect(decision.fieldKey).toBe('title');
    expect(decision.question).toContain('título');
  });

  it('pergunta o próximo campo pendente', async () => {
    const decision = await planner.evaluate({
      message: 'Erro ao abrir pedidos',
      state: buildState({ answers: { title: 'Erro ao abrir pedidos' } }),
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(decision.type).toBe('ask');

    if (decision.type !== 'ask') {
      throw new Error('Decisão inesperada');
    }

    expect(decision.fieldKey).toBe('environment');
  });

  it('solicita a criação da issue quando todos os campos estão preenchidos', async () => {
    const decision = await planner.evaluate({
      message: 'Fim',
      state: buildState({
        answers: {
          title: 'Erro ao abrir pedidos',
          environment: 'Produção, versão 1.2.0, Chrome 120',
          steps: '1. Entrar no sistema\n2. Abrir a tela de pedidos',
          expected: 'A tela de pedidos deve abrir',
          actual: 'A tela fica em branco',
        },
      }),
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(decision.type).toBe('create_issue');

    if (decision.type !== 'create_issue') {
      throw new Error('Decisão inesperada');
    }

    expect(decision.title).toBe('Erro ao abrir pedidos');
    expect(decision.body).toContain('## Ambiente');
    expect(decision.body).toContain('## Passos para reproduzir');
    expect(decision.body).toContain('Ao abrir a tela de pedidos recebo um erro.');
  });

  it('repergunta um campo que passou do limite de caracteres', async () => {
    const decision = await planner.evaluate({
      message: 'x'.repeat(121),
      state: buildState({ answers: { title: 'x'.repeat(121) } }),
      fields: ISSUE_REPORT_FIELDS,
    });

    expect(decision.type).toBe('ask');

    if (decision.type !== 'ask') {
      throw new Error('Decisão inesperada');
    }

    expect(decision.fieldKey).toBe('title');
    expect(decision.question).toContain('limite de 120 caracteres');
  });
});
