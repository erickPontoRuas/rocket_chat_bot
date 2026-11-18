import type { ConversationState, FieldDefinition } from '../conversation/types.js';

export function resolveFieldAnswers(
  state: ConversationState,
  fields: FieldDefinition[],
): Record<string, string> {
  const answers: Record<string, string> = { ...state.answers };
  const firstField = fields[0];

  if (firstField && !answers[firstField.key]?.trim()) {
    answers[firstField.key] = state.initialMessage;
  }

  return answers;
}
