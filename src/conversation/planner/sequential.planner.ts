import type {
  ConversationPlanner,
  FieldDefinition,
  PlannerDecision,
  PlannerInput,
} from '../types.js';
import { resolveFieldAnswers } from '../../flows/answers.js';
import { buildIssueContent } from '../../integrations/github/issue.builder.js';

export class SequentialPlanner implements ConversationPlanner {
  constructor(
    private readonly fields: FieldDefinition[],
    private readonly rocketChatUrl: string,
  ) {}

  async evaluate(input: PlannerInput): Promise<PlannerDecision> {
    const answers = resolveFieldAnswers(input.state, this.fields);

    for (const field of this.fields) {
      const value = answers[field.key]?.trim();

      if (value && field.maxLength && value.length > field.maxLength) {
        return {
          type: 'ask',
          fieldKey: field.key,
          question: `A resposta anterior passou do limite de ${field.maxLength} caracteres. ${field.question}`,
        };
      }
    }

    const nextField = this.fields.find((field) => field.required && !answers[field.key]?.trim());

    if (nextField) {
      return {
        type: 'ask',
        fieldKey: nextField.key,
        question: nextField.question,
      };
    }

    const content = buildIssueContent({
      state: input.state,
      fields: this.fields,
      rocketChatUrl: this.rocketChatUrl,
    });

    return { type: 'create_issue', ...content };
  }
}
