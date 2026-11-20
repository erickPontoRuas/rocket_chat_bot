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
const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;
const MIN_EVIDENCE_CHARS = 3;
const MIN_SUBSTANTIVE_WORDS = 2;
const ATENDIMENTO_ID_DIGIT_REGEX = /\d/;
const NOT_APPLICABLE = 'não se aplica';
const PLACEHOLDER_VALUES = new Set([
  'teste',
  'test',
  'oi',
  'ola',
  'nao informado',
  'n/a',
  'na',
  'desconhecido',
  '-',
]);

type RejectReason =
  | 'trivial'
  | 'empty'
  | 'placeholder'
  | 'no-evidence'
  | 'duplicate'
  | 'invalid-level'
  | 'invalid-id'
  | 'invalid-print';

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
        return sanitizeIntake(parsed, input, (fieldKey, reason) => {
          this.deps.logger.debug(
            { fieldKey, reason, schemaName: 'issue_intake' },
            'Item do intake descartado',
          );
        });
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
  onReject: (fieldKey: string, reason: RejectReason) => void = () => undefined,
): ReportIntake {
  const values: Record<string, string> = {};
  const grounding = buildGroundingText(input.message, input.attachments);
  const trivial = !parsed.hasReportContent || isTrivialReport(input.message, input.attachments);

  if (trivial) {
    for (const field of input.fields) {
      if (parsed.items[field.key]?.present) {
        onReject(field.key, 'trivial');
      }
    }
  } else {
    const candidates: Array<{ key: string; value: string; normalizedValue: string }> = [];

    for (const field of input.fields) {
      const item = parsed.items[field.key];

      if (!item?.present) {
        continue;
      }

      const value = item.value.trim();

      if (!value) {
        onReject(field.key, 'empty');
        continue;
      }

      const normalizedValue = normalizeForMatch(value);

      if (PLACEHOLDER_VALUES.has(normalizedValue)) {
        onReject(field.key, 'placeholder');
        continue;
      }

      const evidence = normalizeForMatch(item.evidence);

      if (evidence.length < MIN_EVIDENCE_CHARS || !grounding.includes(evidence)) {
        onReject(field.key, 'no-evidence');
        continue;
      }

      candidates.push({ key: field.key, value, normalizedValue });
    }

    const counts = new Map<string, number>();

    for (const candidate of candidates) {
      counts.set(candidate.normalizedValue, (counts.get(candidate.normalizedValue) ?? 0) + 1);
    }

    for (const candidate of candidates) {
      const duplicated = (counts.get(candidate.normalizedValue) ?? 0) > 1;
      const notApplicable = candidate.normalizedValue === normalizeForMatch(NOT_APPLICABLE);

      if (duplicated && !notApplicable) {
        onReject(candidate.key, 'duplicate');
        continue;
      }

      values[candidate.key] = candidate.value;
    }
  }

  const level = values.nivel?.trim().toUpperCase();

  if (level && isIssueLevel(level)) {
    values.nivel = level;
  } else if (values.nivel !== undefined) {
    delete values.nivel;
    onReject('nivel', 'invalid-level');
  }

  const atendimentoId = values.atendimentoId;

  if (
    atendimentoId !== undefined &&
    normalizeForMatch(atendimentoId) !== normalizeForMatch(NOT_APPLICABLE) &&
    !ATENDIMENTO_ID_DIGIT_REGEX.test(atendimentoId)
  ) {
    delete values.atendimentoId;
    onReject('atendimentoId', 'invalid-id');
  }

  const printValue = resolvePrintValue(values.print, input.message, input.attachments);

  if (printValue) {
    values.print = printValue;
  } else if (values.print !== undefined) {
    delete values.print;
    onReject('print', 'invalid-print');
  }

  const missing = input.fields
    .filter((field) => !values[field.key]?.trim())
    .map((field) => field.key);

  return { values, missing };
}

function buildGroundingText(message: string, attachments: MessageAttachment[]): string {
  const parts = [message];

  for (const attachment of attachments) {
    parts.push(attachment.url);

    if (attachment.name) {
      parts.push(attachment.name);
    }
  }

  return normalizeForMatch(parts.join('\n'));
}

function isTrivialReport(message: string, attachments: MessageAttachment[]): boolean {
  if (attachments.some((attachment) => attachment.isImage)) {
    return false;
  }

  return message.trim().split(/\s+/).filter(Boolean).length < MIN_SUBSTANTIVE_WORDS;
}

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
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
    return unique(textUrls.map(stripTrailingPunctuation)).join('\n');
  }

  const candidate = aiValue?.trim();

  if (!candidate) {
    return '';
  }

  const messageUrls = new Set(
    (message.match(URL_REGEX) ?? []).map((url) => stripTrailingPunctuation(url)),
  );
  const grounded = candidate
    .split(/\s+/)
    .map((url) => stripTrailingPunctuation(url))
    .filter((url) => /^https?:\/\//i.test(url) && messageUrls.has(url));

  return unique(grounded).join('\n');
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[,.;!?)\]]+$/g, '');
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
