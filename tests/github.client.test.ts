import { describe, expect, it } from 'vitest';
import { mergeLabels } from '../src/integrations/github/github.client.js';

describe('mergeLabels', () => {
  it('mantém apenas a label de nível informada e descarta as demais de GITHUB_LABELS', () => {
    expect(mergeLabels(['ATRAPALHA', 'PERDE VENDA', 'bug'], ['PERDE VENDA'])).toEqual([
      'bug',
      'PERDE VENDA',
    ]);

    expect(mergeLabels(['atrapalha', 'perde venda', 'bug'], ['ATRAPALHA'])).toEqual([
      'bug',
      'ATRAPALHA',
    ]);
  });

  it('não adiciona label de nível quando nenhuma foi informada', () => {
    expect(mergeLabels(['ATRAPALHA', 'PERDE VENDA', 'bug'], [])).toEqual(['bug']);
  });

  it('aplica só a primeira label de nível quando mais de uma é informada', () => {
    expect(mergeLabels(['bug'], ['ATRAPALHA', 'PERDE VENDA'])).toEqual(['bug', 'ATRAPALHA']);
  });

  it('preserva labels fixas e deduplica ignorando maiúsculas', () => {
    expect(mergeLabels(['Bug', 'prioridade', 'bug'], [])).toEqual(['Bug', 'prioridade']);
  });
});
