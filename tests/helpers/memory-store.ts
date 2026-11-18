import type { ConversationStore } from '../../src/conversation/state.repository.js';

export class MemoryStore implements ConversationStore {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async setIfAbsent(key: string, value: string): Promise<boolean> {
    if (this.data.has(key)) {
      return false;
    }

    this.data.set(key, value);
    return true;
  }

  async exists(key: string): Promise<boolean> {
    return this.data.has(key);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}
