import type { FieldDefinition } from '../conversation/types.js';

export const LEVEL_VALUES = ['ATRAPALHA', 'PERDE VENDA'] as const;

export type IssueLevel = (typeof LEVEL_VALUES)[number];

export const ISSUE_REPORT_FIELDS: FieldDefinition[] = [
  {
    key: 'nivel',
    label: 'Nível',
    question: 'Qual é o nível do problema? Responda com **ATRAPALHA** ou **PERDE VENDA**.',
    allowsNotApplicable: false,
  },
  {
    key: 'atendimentoId',
    label: 'ID do atendimento',
    question: 'Qual é o ID do atendimento?',
    allowsNotApplicable: true,
  },
  {
    key: 'etapaFunil',
    label: 'Etapa do funil',
    question: 'Em qual etapa do funil o cliente estava?',
    allowsNotApplicable: true,
  },
  {
    key: 'clienteDisse',
    label: 'O que o cliente disse ou pediu',
    question: 'O que o cliente disse ou pediu?',
    allowsNotApplicable: true,
  },
  {
    key: 'botFez',
    label: 'O que o bot fez',
    question: 'O que o bot fez?',
    allowsNotApplicable: true,
  },
  {
    key: 'botDeveriaTerFeito',
    label: 'O que o bot deveria ter feito',
    question: 'O que o bot deveria ter feito?',
    allowsNotApplicable: true,
  },
  {
    key: 'regraNegocio',
    label: 'Regra de negócio',
    question: 'Qual regra de negócio está relacionada a este caso?',
    allowsNotApplicable: true,
  },
  {
    key: 'jaAconteceuAntes',
    label: 'Já aconteceu antes?',
    question: 'Isso já aconteceu antes? Se sim, em que contexto?',
    allowsNotApplicable: true,
  },
  {
    key: 'print',
    label: 'Print',
    question: 'Envie o print como anexo ou link de imagem.',
    allowsNotApplicable: true,
  },
];

export function isIssueLevel(value: string): value is IssueLevel {
  return (LEVEL_VALUES as readonly string[]).includes(value);
}
