import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertRobinTelegramCredentials,
  resolveRobinTelegramCredentials,
  sendRobinProjectMessage,
} from '../apps/telegram-lp-bot/src/telegram-sender.js';

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
  vi.restoreAllMocks();
});

describe('Robin Telegram sender isolation', () => {
  it('ignores generic credentials and fails closed', async () => {
    delete process.env.ROBIN_TELEGRAM_BOT_TOKEN;
    delete process.env.ROBIN_TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_BOT_TOKEN = 'generic-token';
    process.env.TELEGRAM_CHAT_ID = 'generic-chat';
    expect(resolveRobinTelegramCredentials().token).toBeUndefined();
    expect(() => assertRobinTelegramCredentials()).toThrow('ROBIN_TELEGRAM_BOT_TOKEN is required');
    const fetchMock = vi.fn();
    const result = await sendRobinProjectMessage('x', 'test', fetchMock as unknown as typeof fetch);
    expect(result.delivered).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses only project credentials and returns Telegram message ID', async () => {
    process.env.ROBIN_TELEGRAM_BOT_TOKEN = 'robin-token';
    process.env.ROBIN_TELEGRAM_CHAT_ID = 'robin-chat';
    process.env.TELEGRAM_BOT_TOKEN = 'generic-token';
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain('robin-token');
      expect(url).not.toContain('generic-token');
      expect(String(init.body)).toContain('robin-chat');
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 73 } }),
      };
    });
    const result = await sendRobinProjectMessage('x', 'test_success', fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ delivered: true, messageId: 73 });
  });
});
