import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface LockHandle {
  release(): Promise<void>;
}

export interface Locker {
  acquire(key: string, ttlMs: number): Promise<LockHandle | null>;
}

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

export class RedisLocker implements Locker {
  constructor(private readonly redis: Redis) {}

  async acquire(key: string, ttlMs: number): Promise<LockHandle | null> {
    const token = randomUUID();
    const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');

    if (result !== 'OK') {
      return null;
    }

    return {
      release: async () => {
        await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
      },
    };
  }
}
