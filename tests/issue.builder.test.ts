import { describe, expect, it } from 'vitest';
import { buildIssueContent } from '../src/integrations/github/issue.builder.js';
import { ISSUE_REPORT_FIELDS } from '../src/flows/issue-report.fields.js';
import { buildState } from './helpers/state.js';

const answers: Record<string, string> = {
  nivel: 'PERDE VENDA',
  atendimentoId: 'ATD-1',
  etapaFunil: 'Checkout',
  clienteDisse: 'Quero finalizar a compra',
  botFez: 'Respondeu que não havia estoque',
  botDeveriaTerFeito: 'Concluir a compra',
  regraNegocio: 'Priorizar a venda',
  jaAconteceuAntes: 'não se aplica',
  print: 'https://chat.exemplo.com/file-upload/print.png',
};

describe('buildIssueContent', () => {
  it('monta título com nível e ID, corpo com metadados e todas as seções', () => {
    const content = buildIssueContent({
      state: buildState({ answers }),
      fields: ISSUE_REPORT_FIELDS,
      rocketChatUrl: 'https://chat.exemplo.com/',
      level: 'PERDE VENDA',
      title: 'Erro ao finalizar pedido',
    });

    expect(content.title).toBe('[PERDE VENDA] #ATD-1 - Erro ao finalizar pedido');
    expect(content.labels).toEqual(['PERDE VENDA']);
    expect(content.body).toContain('**Solicitante:** ana');
    expect(content.body).toContain('https://chat.exemplo.com/channel/room-1?msg=msg-1');
    expect(content.body).toContain('**Nível:** PERDE VENDA');

    for (const field of ISSUE_REPORT_FIELDS) {
      expect(content.body).toContain(`## ${field.label}`);
    }

    expect(content.body).toContain('## Já aconteceu antes?\n\nnão se aplica');
    expect(content.body).toContain('## Print\n\nhttps://chat.exemplo.com/file-upload/print.png');
  });

  it('omite do título um ID que não parece identificador, mas mantém no corpo', () => {
    const content = buildIssueContent({
      state: buildState({ answers: { ...answers, atendimentoId: 'não se aplica' } }),
      fields: ISSUE_REPORT_FIELDS,
      rocketChatUrl: 'https://chat.exemplo.com',
      level: 'PERDE VENDA',
      title: 'Erro ao finalizar pedido',
    });

    expect(content.title).toBe('[PERDE VENDA] Erro ao finalizar pedido');
    expect(content.body).toContain('## ID do atendimento\n\nnão se aplica');
  });

  it('usa fallback quando a IA não gera título', () => {
    const content = buildIssueContent({
      state: buildState({
        answers: {
          ...answers,
          clienteDisse: 'Cliente pediu para finalizar a compra',
        },
      }),
      fields: ISSUE_REPORT_FIELDS,
      rocketChatUrl: 'https://chat.exemplo.com',
      level: 'PERDE VENDA',
      title: '',
    });

    expect(content.title).toBe('[PERDE VENDA] #ATD-1 - Cliente pediu para finalizar a compra');
  });

  it('usa a mensagem inicial no fallback quando o cliente não foi coletado', () => {
    const content = buildIssueContent({
      state: buildState({
        answers: { ...answers, clienteDisse: '' },
        initialMessage: 'Ao abrir a tela de pedidos recebo um erro.',
      }),
      fields: ISSUE_REPORT_FIELDS,
      rocketChatUrl: 'https://chat.exemplo.com',
      level: 'ATRAPALHA',
      title: '',
    });

    expect(content.title).toBe('[ATRAPALHA] #ATD-1 - Ao abrir a tela de pedidos recebo um erro.');
  });

  it('trunca títulos longos', () => {
    const content = buildIssueContent({
      state: buildState({ answers }),
      fields: ISSUE_REPORT_FIELDS,
      rocketChatUrl: 'https://chat.exemplo.com',
      level: 'PERDE VENDA',
      title: 'a'.repeat(200),
    });

    expect(content.title.length).toBeLessThanOrEqual(140);
    expect(content.title.endsWith('…')).toBe(true);
  });
});
