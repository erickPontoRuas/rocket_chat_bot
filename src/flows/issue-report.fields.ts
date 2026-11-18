import type { FieldDefinition } from '../conversation/types.js';

export const ISSUE_REPORT_FIELDS: FieldDefinition[] = [
  {
    key: 'description',
    label: 'Descrição',
    question: 'Descreva o problema com o máximo de detalhes possível.',
    required: true,
  },
  {
    key: 'title',
    label: 'Título',
    question: 'Qual seria um título curto e objetivo para a issue?',
    required: true,
    maxLength: 120,
  },
  {
    key: 'environment',
    label: 'Ambiente',
    question: 'Em qual ambiente isso ocorre? Informe produção/homologação, versão e navegador.',
    required: true,
  },
  {
    key: 'steps',
    label: 'Passos para reproduzir',
    question: 'Quais passos reproduzem o problema?',
    required: true,
  },
  {
    key: 'expected',
    label: 'Comportamento esperado',
    question: 'O que era esperado acontecer?',
    required: true,
  },
  {
    key: 'actual',
    label: 'Comportamento atual',
    question: 'O que aconteceu de fato?',
    required: true,
  },
];
