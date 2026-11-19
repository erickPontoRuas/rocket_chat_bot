import type { FieldDefinition, MessageAttachment } from '../../conversation/types.js';
import type { IssueLevel } from '../../flows/issue-report.fields.js';

export type { IssueLevel };

export interface ReportIntake {
  values: Record<string, string>;
  missing: string[];
}

export interface ReportAnalyzer {
  analyze(input: {
    message: string;
    attachments: MessageAttachment[];
    fields: FieldDefinition[];
  }): Promise<ReportIntake>;
}

export interface LevelNormalizer {
  normalize(input: { answer: string }): Promise<IssueLevel | null>;
}

export interface TitleGenerator {
  generate(input: {
    answers: Record<string, string>;
    fields: FieldDefinition[];
    level: IssueLevel;
  }): Promise<string>;
}

export interface JsonCompletionClient {
  complete(input: {
    system: string;
    user: string;
    schemaName: string;
    schema: Record<string, unknown>;
  }): Promise<string>;
}
