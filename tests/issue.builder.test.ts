import { describe, expect, it } from 'vitest';
import { buildIssueContent } from '../src/integrations/github/issue.builder.js';
import { ISSUE_REPORT_FIELDS } from '../src/flows/issue-report.fields.js';
import { buildState } from './helpers/state.js';

describe('buildIssueContent', () => {
  it('monta título, corpo e link da thread', () => {
    const content = buildIssueContent({
      state: buildState({
        answers: {
          title: 'Erro ao abrir pedidos',
          environment: 'Produção',
          steps: 'Abrir a tela de pedidos',
          expected: 'Abrir a tela',
          actual: 'Tela em branco',
        },
      }),
      fields: ISSUE_REPORT_FIELDS,
      rocketChatUrl: 'https://chat.exemplo.com/',
    });

    expect(content.title).toBe('Erro ao abrir pedidos');
    expect(content.body).toContain('**Solicitante:** ana');
    expect(content.body).toContain('https://chat.exemplo.com/channel/room-1?msg=msg-1');
    expect(content.body).toContain('## Descrição');
    expect(content.body).toContain('## Ambiente');
    expect(content.body).toContain('## Comportamento atual');
  });

  it('usa a mensagem inicial como título quando o título não foi respondido', () => {
    const content = buildIssueContent({
      state: buildState(),
      fields: ISSUE_REPORT_FIELDS,
      rocketChatUrl: 'https://chat.exemplo.com',
    });

    expect(content.title).toBe('Ao abrir a tela de pedidos recebo um erro.');
  });

  it('trunca títulos longos', () => {
    const longTitle = 'a'.repeat(200);
    const content = buildIssueContent({
      state: buildState({ answers: { title: longTitle } }),
      fields: ISSUE_REPORT_FIELDS,
      rocketChatUrl: 'https://chat.exemplo.com',
    });

    expect(content.title.length).toBeLessThanOrEqual(120);
    expect(content.title.endsWith('…')).toBe(true);
  });
});
