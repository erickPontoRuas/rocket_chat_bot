import type { ConversationState, FieldDefinition } from '../../conversation/types.js';
import type { IssueLevel } from '../../flows/issue-report.fields.js';

const MAX_TITLE_LENGTH = 140;
const MAX_FALLBACK_TITLE_LENGTH = 80;
const MAX_BODY_LENGTH = 60_000;

const ID_FORMAT_REGEX = /^[A-Za-z0-9._-]+$/;

export interface IssueContent {
  title: string;
  body: string;
  labels: string[];
}

export function buildIssueContent(input: {
  state: ConversationState;
  fields: FieldDefinition[];
  rocketChatUrl: string;
  level: IssueLevel;
  title: string;
}): IssueContent {
  return {
    title: buildTitle(input.title, input.state),
    body: buildBody(input.state, input.fields, input.rocketChatUrl, input.level),
    labels: [input.level],
  };
}

function buildTitle(aiTitle: string, state: ConversationState): string {
  const baseTitle = cleanTitle(aiTitle) || buildFallbackTitle(state);
  const atendimentoId = state.answers.atendimentoId?.trim();
  const idPart = atendimentoId && ID_FORMAT_REGEX.test(atendimentoId) ? `#${atendimentoId} - ` : '';

  return truncate(`${idPart}${baseTitle}`, MAX_TITLE_LENGTH);
}

function buildFallbackTitle(state: ConversationState): string {
  const candidate =
    state.answers.clienteDisse?.trim() ||
    state.initialMessage.trim() ||
    `Solicitação de ${state.username}`;

  return truncate(cleanTitle(candidate), MAX_FALLBACK_TITLE_LENGTH);
}

function buildBody(
  state: ConversationState,
  fields: FieldDefinition[],
  rocketChatUrl: string,
  level: IssueLevel,
): string {
  const header = [
    `**Solicitante:** ${state.username} (\`${state.userId}\`)`,
    `**Canal:** \`${state.roomId}\``,
    `**Mensagem no Rocket.Chat:** ${buildMessageLink(rocketChatUrl, state)}`,
    `**Nível:** ${level}`,
  ].join('\n');

  const sections = fields.map((field) => {
    const value = state.answers[field.key]?.trim() || '_Não informado_';
    return `## ${field.label}\n\n${value}`;
  });

  const body = [
    header,
    '---',
    ...sections,
    '',
    '_Issue criada automaticamente pelo bot do Rocket.Chat._',
  ].join('\n\n');

  if (body.length <= MAX_BODY_LENGTH) {
    return body;
  }

  const notice = '\n\n_Conteúdo truncado por exceder o limite do GitHub._';
  return `${body.slice(0, MAX_BODY_LENGTH - notice.length).trimEnd()}${notice}`;
}

function buildMessageLink(rocketChatUrl: string, state: ConversationState): string {
  const baseUrl = rocketChatUrl.replace(/\/+$/, '');
  return `${baseUrl}/channel/${encodeURIComponent(state.roomId)}?msg=${encodeURIComponent(state.initialMessageId)}`;
}

function cleanTitle(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}
