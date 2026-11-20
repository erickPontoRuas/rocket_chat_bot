import { z } from 'zod';
import { ISSUE_REPORT_FIELDS } from '../../flows/issue-report.fields.js';

const FIELD_KEYS = ISSUE_REPORT_FIELDS.map((field) => field.key);

const INTAKE_ITEM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['present', 'value', 'evidence'],
  properties: {
    present: { type: 'boolean' },
    value: { type: 'string' },
    evidence: { type: 'string' },
  },
};

export const INTAKE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['hasReportContent', 'items'],
  properties: {
    hasReportContent: { type: 'boolean' },
    items: {
      type: 'object',
      additionalProperties: false,
      required: FIELD_KEYS,
      properties: Object.fromEntries(FIELD_KEYS.map((key) => [key, INTAKE_ITEM_SCHEMA])),
    },
  },
};

export const LEVEL_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['level'],
  properties: {
    level: {
      type: 'string',
      enum: ['ATRAPALHA', 'PERDE VENDA', 'NENHUM'],
    },
  },
};

export const TITLE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    title: { type: 'string' },
  },
};

export const intakeResponseSchema = z.object({
  hasReportContent: z.boolean(),
  items: z.record(
    z.string(),
    z.object({
      present: z.boolean(),
      value: z.string(),
      evidence: z.string(),
    }),
  ),
});

export const levelResponseSchema = z.object({
  level: z.enum(['ATRAPALHA', 'PERDE VENDA', 'NENHUM']),
});

export const titleResponseSchema = z.object({
  title: z.string(),
});

export type IntakeResponse = z.infer<typeof intakeResponseSchema>;
export type LevelResponse = z.infer<typeof levelResponseSchema>;
export type TitleResponse = z.infer<typeof titleResponseSchema>;
