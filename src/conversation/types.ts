export type ConversationStatus = 'collecting' | 'creating_issue' | 'completed' | 'failed';

export interface MessageAttachment {
  url: string;
  name?: string;
  mimeType?: string;
  isImage: boolean;
}

export interface ConversationState {
  version: 3;
  roomId: string;
  userId: string;
  username: string;
  initialMessageId: string;
  initialMessage: string;
  initialAttachments: MessageAttachment[];
  status: ConversationStatus;
  intakeDone: boolean;
  answers: Record<string, string>;
  questionQueue: string[];
  pendingFieldKey: string | null;
  levelRetryCount: number;
  lastMessageId: string;
  lastActivityAt: string;
  issueNumber?: number;
  issueUrl?: string;
  issueTitle?: string;
  error?: string;
}

export interface IncomingMessage {
  id: string;
  roomId: string;
  userId: string;
  username: string;
  text: string;
  attachments: MessageAttachment[];
}

export interface FieldDefinition {
  key: string;
  label: string;
  question: string;
  allowsNotApplicable: boolean;
}

export interface MessageSender {
  reply(roomId: string, text: string): Promise<void>;
}

export interface CreatedIssue {
  number: number;
  url: string;
}

export interface IssueCreator {
  createIssue(input: { title: string; body: string; labels?: string[] }): Promise<CreatedIssue>;
}

export interface MessageProcessor {
  handleMessage(message: IncomingMessage): Promise<void>;
}
