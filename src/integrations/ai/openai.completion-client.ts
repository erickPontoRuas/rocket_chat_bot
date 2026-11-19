import OpenAI from 'openai';
import type { JsonCompletionClient } from './types.js';

interface OpenAiJsonCompletionClientDependencies {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
}

export class OpenAiJsonCompletionClient implements JsonCompletionClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(deps: OpenAiJsonCompletionClientDependencies) {
    this.client = new OpenAI({
      apiKey: deps.apiKey,
      ...(deps.baseUrl ? { baseURL: deps.baseUrl } : {}),
      timeout: deps.timeoutMs,
      maxRetries: 0,
    });
    this.model = deps.model;
  }

  async complete(input: {
    system: string;
    user: string;
    schemaName: string;
    schema: Record<string, unknown>;
  }): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: input.schemaName,
          strict: true,
          schema: input.schema,
        },
      },
    });

    const content = response.choices[0]?.message?.content;

    if (!content) {
      throw new Error('A IA não retornou conteúdo');
    }

    return content;
  }
}
