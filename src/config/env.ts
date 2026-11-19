import 'dotenv/config';
import { z } from 'zod';
import { ConfigurationError } from '../utils/errors.js';

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: logLevelSchema.default('info'),
  ROCKETCHAT_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
      message: 'deve ser uma URL http(s)',
    }),
  ROCKETCHAT_USER: z.string().min(1),
  ROCKETCHAT_PASSWORD: z.string().min(1),
  ROCKETCHAT_ROOM_ID: z.string().min(1),
  REDIS_URL: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://'), {
      message: 'deve ser uma URL redis:// ou rediss://',
    }),
  CONVERSATION_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_OWNER: z.string().min(1),
  GITHUB_REPO: z.string().min(1),
  GITHUB_LABELS: z.string().optional(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_BASE_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
      message: 'deve ser uma URL http(s)',
    })
    .optional(),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export type LogLevel = z.infer<typeof logLevelSchema>;
export type NodeEnv = 'development' | 'test' | 'production';

export interface AppConfig {
  nodeEnv: NodeEnv;
  logLevel: LogLevel;
  rocketChat: {
    url: string;
    username: string;
    password: string;
    roomId: string;
  };
  redis: {
    url: string;
    conversationTtlSeconds: number;
  };
  github: {
    token: string;
    owner: string;
    repo: string;
    labels: string[];
  };
  ai: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    timeoutMs: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new ConfigurationError(`Configuracao invalida: ${details}`);
  }

  const data = parsed.data;

  return {
    nodeEnv: data.NODE_ENV,
    logLevel: data.LOG_LEVEL,
    rocketChat: {
      url: data.ROCKETCHAT_URL.replace(/\/+$/, ''),
      username: data.ROCKETCHAT_USER,
      password: data.ROCKETCHAT_PASSWORD,
      roomId: data.ROCKETCHAT_ROOM_ID,
    },
    redis: {
      url: data.REDIS_URL,
      conversationTtlSeconds: data.CONVERSATION_TTL_SECONDS,
    },
    github: {
      token: data.GITHUB_TOKEN,
      owner: data.GITHUB_OWNER,
      repo: data.GITHUB_REPO,
      labels: parseLabels(data.GITHUB_LABELS),
    },
    ai: {
      apiKey: data.OPENAI_API_KEY,
      model: data.OPENAI_MODEL,
      ...(data.OPENAI_BASE_URL ? { baseUrl: data.OPENAI_BASE_URL } : {}),
      timeoutMs: data.OPENAI_TIMEOUT_MS,
    },
  };
}

function parseLabels(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}
