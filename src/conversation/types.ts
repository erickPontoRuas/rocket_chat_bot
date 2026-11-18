export type ConversationStatus = 'collecting' | 'creating_issue' | 'completed' | 'failed';

export interface ConversationState {
  version: 1;
  roomId: string;
  userId: string;
  username: string;
  threadId: string;
  initialMessage: string;
  status: ConversationStatus;
  answers: Record<string, string>;
  askedFields: string[];
  pendingFieldKey: string | null;
  lastMessageId: string;
  lastActivityAt: string;
  issueUrl?: string;
  error?: string;
}

export interface IncomingMessage {
  id: string;
  roomId: string;
  userId: string;
  username: string;
  text: string;
  threadId: string;
}

export interface FieldDefinition {
  key: string;
  label: string;
  question: string;
  required: boolean;
  maxLength?: number;
}

export interface PlannerInput {
  message: string;
  state: ConversationState;
  fields: FieldDefinition[];
}

export type PlannerDecision =
  | { type: 'ask'; fieldKey: string; question: string }
  | { type: 'create_issue'; title: string; body: string }
  | { type: 'ignore'; reason?: string };

export interface ConversationPlanner {
  evaluate(input: PlannerInput): Promise<PlannerDecision>;
}

export interface MessageSender {
  replyInThread(roomId: string, threadId: string, text: string): Promise<void>;
}

export interface CreatedIssue {
  number: number;
  url: string;
}

export interface IssueCreator {
  createIssue(input: { title: string; body: string }): Promise<CreatedIssue>;
}

export interface MessageProcessor {
  handleMessage(message: IncomingMessage): Promise<void>;
}
