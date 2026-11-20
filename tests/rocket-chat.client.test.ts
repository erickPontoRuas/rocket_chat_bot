import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prepareMessage, sendMessage } = vi.hoisted(() => ({
  prepareMessage: vi.fn((text: string, roomId: string) => ({ msg: text, rid: roomId })),
  sendMessage: vi.fn(async (_payload: unknown) => undefined),
}));

vi.mock('@rocket.chat/sdk', () => ({
  driver: { prepareMessage, sendMessage },
}));

import { RocketChatClient } from '../src/bot/rocket-chat.client.js';
import { silentLogger } from './helpers/logger.js';

describe('RocketChatClient.reply', () => {
  beforeEach(() => {
    prepareMessage.mockClear();
    sendMessage.mockClear();
  });

  it('envia a mensagem no canal sem criar thread', async () => {
    const client = new RocketChatClient({
      url: 'https://chat.exemplo.com',
      username: 'bot',
      password: 'secret',
      roomId: 'room-1',
      logger: silentLogger,
      onMessage: () => undefined,
    });

    await client.reply('room-1', '@ana Olá');

    expect(prepareMessage).toHaveBeenCalledWith('@ana Olá', 'room-1');
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const payload = sendMessage.mock.calls[0]?.[0];
    expect(payload).toEqual({ msg: '@ana Olá', rid: 'room-1' });
    expect(payload).not.toHaveProperty('tmid');
  });
});
