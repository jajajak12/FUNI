import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertFuniTelegramCredentials,
  resolveFuniTelegramCredentials,
  sendFuniMessage,
} from '../apps/telegram-lp-bot/src/telegram-sender.js';

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
  vi.restoreAllMocks();
});

describe('FUNI Telegram sender isolation', () => {
  it('ignores generic credentials and fails closed', async () => {
    delete process.env.FUNI_TELEGRAM_BOT_TOKEN;
    delete process.env.FUNI_TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_BOT_TOKEN = 'generic-token';
    process.env.TELEGRAM_CHAT_ID = 'generic-chat';
    expect(resolveFuniTelegramCredentials().token).toBeUndefined();
    expect(() => assertFuniTelegramCredentials()).toThrow('FUNI_TELEGRAM_BOT_TOKEN is required');
    const fetchMock = vi.fn();
    const result = await sendFuniMessage('x', 'test', fetchMock as unknown as typeof fetch);
    expect(result.delivered).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses only project credentials and returns Telegram message ID', async () => {
    process.env.FUNI_TELEGRAM_BOT_TOKEN = 'synthetic-funi-token';
    process.env.FUNI_TELEGRAM_CHAT_ID = 'synthetic-funi-chat';
    process.env.TELEGRAM_BOT_TOKEN = 'generic-token';
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain('synthetic-funi-token');
      expect(url).not.toContain('generic-token');
      expect(String(init.body)).toContain('synthetic-funi-chat');
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 73 } }),
      };
    });
    const result = await sendFuniMessage('x', 'test_success', fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ delivered: true, messageId: 73 });
  });
});
