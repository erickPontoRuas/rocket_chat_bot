import type { Redis } from 'ioredis';
import type { ConversationState } from '../conversation/types.js';

const MESSAGE_DEDUPE_TTL_SECONDS = 3600;

export function conversationKey(roomId: string, userId: string): string {
  return `conversation:${roomId}:${userId}`;
}

export function messageDedupeKey(messageId: string): string {
  return `dedupe:msg:${messageId}`;
}

export interface ConversationStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export class RedisConversationStore implements ConversationStore {
  constructor(private readonly redis: Redis) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async exists(key: string): Promise<boolean> {
    return (await this.redis.exists(key)) === 1;
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

export class ConversationRepository {
  constructor(
    private readonly store: ConversationStore,
    private readonly ttlSeconds: number,
  ) {}

  async get(roomId: string, userId: string): Promise<ConversationState | null> {
    const raw = await this.store.get(conversationKey(roomId, userId));

    if (!raw) {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(raw);

      if (!isConversationState(parsed)) {
        await this.delete(roomId, userId);
        return null;
      }

      return parsed;
    } catch {
      await this.delete(roomId, userId);
      return null;
    }
  }

  async save(state: ConversationState): Promise<void> {
    await this.store.set(
      conversationKey(state.roomId, state.userId),
      JSON.stringify(state),
      this.ttlSeconds,
    );
  }

  async delete(roomId: string, userId: string): Promise<void> {
    await this.store.delete(conversationKey(roomId, userId));
  }

  async isMessageProcessed(messageId: string): Promise<boolean> {
    return this.store.exists(messageDedupeKey(messageId));
  }

  async markMessageProcessed(messageId: string): Promise<boolean> {
    return this.store.setIfAbsent(messageDedupeKey(messageId), '1', MESSAGE_DEDUPE_TTL_SECONDS);
  }
}

function isConversationState(value: unknown): value is ConversationState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<ConversationState>;

  return (
    candidate.version === 2 &&
    typeof candidate.roomId === 'string' &&
    typeof candidate.userId === 'string' &&
    typeof candidate.username === 'string' &&
    typeof candidate.threadId === 'string' &&
    typeof candidate.initialMessage === 'string' &&
    Array.isArray(candidate.initialAttachments) &&
    typeof candidate.status === 'string' &&
    typeof candidate.intakeDone === 'boolean' &&
    typeof candidate.answers === 'object' &&
    candidate.answers !== null &&
    Array.isArray(candidate.questionQueue) &&
    candidate.questionQueue.every((key) => typeof key === 'string') &&
    (candidate.pendingFieldKey === null || typeof candidate.pendingFieldKey === 'string') &&
    typeof candidate.levelRetryCount === 'number' &&
    typeof candidate.lastMessageId === 'string' &&
    typeof candidate.lastActivityAt === 'string'
  );
}
