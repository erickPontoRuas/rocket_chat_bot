import type { ConversationState, FieldDefinition } from '../../conversation/types.js';
import { resolveFieldAnswers } from '../../flows/answers.js';

export interface IssueContent {
  title: string;
  body: string;
}

export function buildIssueContent(input: {
  state: ConversationState;
  fields: FieldDefinition[];
  rocketChatUrl: string;
}): IssueContent {
  const answers = resolveFieldAnswers(input.state, input.fields);
  const title = buildTitle(answers, input.state);
  const threadLink = buildThreadLink(input.rocketChatUrl, input.state);

  const sections = input.fields
    .filter((field) => field.key !== 'title')
    .map((field) => {
      const value = answers[field.key]?.trim();

      if (!value) {
        return null;
      }

      return `## ${field.label}\n\n${value}`;
    })
    .filter((section): section is string => section !== null);

  const header = [
    `**Solicitante:** ${input.state.username} (\`${input.state.userId}\`)`,
    `**Canal:** \`${input.state.roomId}\``,
    `**Thread no Rocket.Chat:** ${threadLink}`,
  ].join('\n');

  return {
    title,
    body: [
      header,
      '---',
      ...sections,
      '',
      '_Issue criada automaticamente pelo bot do Rocket.Chat._',
    ].join('\n\n'),
  };
}

function buildTitle(answers: Record<string, string>, state: ConversationState): string {
  const explicitTitle = answers.title?.trim();

  if (explicitTitle) {
    return truncate(explicitTitle, 120);
  }

  const description = (answers.description ?? state.initialMessage).trim().replace(/\s+/g, ' ');

  if (description) {
    return truncate(description, 80);
  }

  return truncate(`Solicitação de ${state.username}`, 120);
}

function buildThreadLink(rocketChatUrl: string, state: ConversationState): string {
  const baseUrl = rocketChatUrl.replace(/\/+$/, '');
  return `${baseUrl}/channel/${encodeURIComponent(state.roomId)}?msg=${encodeURIComponent(state.threadId)}`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}
