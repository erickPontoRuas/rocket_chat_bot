import type { Logger } from 'pino';
import type { FieldDefinition, MessageAttachment } from '../../conversation/types.js';
import { isIssueLevel } from '../../flows/issue-report.fields.js';
import type { IssueLevel } from '../../flows/issue-report.fields.js';
import { AiIntegrationError } from '../../utils/errors.js';
import {
  INTAKE_SYSTEM_PROMPT,
  LEVEL_SYSTEM_PROMPT,
  TITLE_SYSTEM_PROMPT,
  buildIntakeUserPrompt,
  buildLevelUserPrompt,
  buildTitleUserPrompt,
} from './prompts.js';
import {
  INTAKE_JSON_SCHEMA,
  LEVEL_JSON_SCHEMA,
  TITLE_JSON_SCHEMA,
  intakeResponseSchema,
  levelResponseSchema,
  titleResponseSchema,
} from './schemas.js';
import type { IntakeResponse } from './schemas.js';
import type {
  JsonCompletionClient,
  LevelNormalizer,
  ReportAnalyzer,
  ReportIntake,
  TitleGenerator,
} from './types.js';

interface OpenAiIssueAssistantDependencies {
  completionClient: JsonCompletionClient;
  logger: Logger;
}

const IMAGE_URL_REGEX = /https?:\/\/[^\s<>"']+\.(?:png|jpe?g|gif|webp|bmp)(?:[?#][^\s<>"']*)?/gi;

export class OpenAiIssueAssistant implements ReportAnalyzer, LevelNormalizer, TitleGenerator {
  constructor(private readonly deps: OpenAiIssueAssistantDependencies) {}

  async analyze(input: {
    message: string;
    attachments: MessageAttachment[];
    fields: FieldDefinition[];
  }): Promise<ReportIntake> {
    const user = buildIntakeUserPrompt(input);
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await this.completeJson({
          system: INTAKE_SYSTEM_PROMPT,
          user,
          schemaName: 'issue_intake',
          schema: INTAKE_JSON_SCHEMA,
        });
        const parsed = intakeResponseSchema.parse(raw);
        return sanitizeIntake(parsed, input);
      } catch (error) {
        lastError = error;
        this.deps.logger.warn(
          { err: error, attempt: attempt + 1 },
          'Falha na avaliação do relato pela IA',
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new AiIntegrationError('Falha ao avaliar o relato com a IA');
  }

  async normalize(input: { answer: string }): Promise<IssueLevel | null> {
    try {
      const raw = await this.completeJson({
        system: LEVEL_SYSTEM_PROMPT,
        user: buildLevelUserPrompt(input.answer),
        schemaName: 'issue_level',
        schema: LEVEL_JSON_SCHEMA,
      });
      const parsed = levelResponseSchema.parse(raw);

      return parsed.level === 'NENHUM' ? null : parsed.level;
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'Falha ao normalizar o nível pela IA');
      return null;
    }
  }

  async generate(input: {
    answers: Record<string, string>;
    fields: FieldDefinition[];
    level: IssueLevel;
  }): Promise<string> {
    const raw = await this.completeJson({
      system: TITLE_SYSTEM_PROMPT,
      user: buildTitleUserPrompt(input),
      schemaName: 'issue_title',
      schema: TITLE_JSON_SCHEMA,
    });
    const parsed = titleResponseSchema.parse(raw);
    const title = cleanupTitle(parsed.title);

    if (!title) {
      throw new AiIntegrationError('A IA retornou um título vazio');
    }

    return title;
  }

  private async completeJson(input: {
    system: string;
    user: string;
    schemaName: string;
    schema: Record<string, unknown>;
  }): Promise<unknown> {
    const startedAt = Date.now();
    const content = await this.deps.completionClient.complete(input);

    this.deps.logger.debug(
      { schemaName: input.schemaName, latencyMs: Date.now() - startedAt },
      'Resposta da IA recebida',
    );

    try {
      return JSON.parse(stripCodeFence(content));
    } catch (error) {
      throw new AiIntegrationError(`Resposta inválida da IA para ${input.schemaName}`, {
        cause: error,
      });
    }
  }
}

function sanitizeIntake(
  parsed: IntakeResponse,
  input: {
    message: string;
    attachments: MessageAttachment[];
    fields: FieldDefinition[];
  },
): ReportIntake {
  const values: Record<string, string> = {};

  for (const field of input.fields) {
    const item = parsed.items[field.key];

    if (!item?.present) {
      continue;
    }

    const value = item.value.trim();

    if (value) {
      values[field.key] = value;
    }
  }

  const level = values.nivel?.trim().toUpperCase();

  if (level && isIssueLevel(level)) {
    values.nivel = level;
  } else {
    delete values.nivel;
  }

  const printValue = resolvePrintValue(values.print, input.message, input.attachments);

  if (printValue) {
    values.print = printValue;
  } else {
    delete values.print;
  }

  const missing = input.fields
    .filter((field) => !values[field.key]?.trim())
    .map((field) => field.key);

  return { values, missing };
}

function resolvePrintValue(
  aiValue: string | undefined,
  message: string,
  attachments: MessageAttachment[],
): string {
  const attachmentUrls = attachments.filter((attachment) => attachment.isImage).map((a) => a.url);

  if (attachmentUrls.length > 0) {
    return unique(attachmentUrls).join('\n');
  }

  const textUrls = message.match(IMAGE_URL_REGEX) ?? [];

  if (textUrls.length > 0) {
    return unique(textUrls).join('\n');
  }

  const candidate = aiValue?.trim();

  if (candidate && /https?:\/\//i.test(candidate)) {
    return candidate;
  }

  return '';
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);

  return match?.[1]?.trim() ?? trimmed;
}

function cleanupTitle(value: string): string {
  const cleaned = value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();

  if (cleaned.length <= 80) {
    return cleaned;
  }

  return `${cleaned.slice(0, 79).trimEnd()}…`;
}
