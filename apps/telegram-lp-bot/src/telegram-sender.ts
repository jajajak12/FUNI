import { createHash } from 'node:crypto';
import type { Bot } from 'grammy';

type TelemetryInput = {
  delivered: boolean;
  category: string;
  destination: string | number | undefined;
  messageId?: string | number | null;
  failureReason?: string | null;
};

export function sha256(value: string | number): string {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function maskedTokenHash(token: string | undefined): string | null {
  if (!token) return null;
  const hash = sha256(token);
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

export function resolveRobinTelegramCredentials() {
  const token = process.env.ROBIN_TELEGRAM_BOT_TOKEN;
  const destination = process.env.ROBIN_TELEGRAM_CHAT_ID;
  return {
    token,
    destination,
    tokenEnvKey: 'ROBIN_TELEGRAM_BOT_TOKEN' as const,
    destinationEnvKey: 'ROBIN_TELEGRAM_CHAT_ID' as const,
  };
}

export function assertRobinTelegramCredentials() {
  const credentials = resolveRobinTelegramCredentials();
  if (!credentials.token) throw new Error('ROBIN_TELEGRAM_BOT_TOKEN is required');
  if (!credentials.destination) throw new Error('ROBIN_TELEGRAM_CHAT_ID is required');
  return {
    ...credentials,
    token: credentials.token,
    destination: credentials.destination,
  };
}

export function emitRobinSenderTelemetry(input: TelemetryInput): void {
  const credentials = resolveRobinTelegramCredentials();
  process.stdout.write(JSON.stringify({
    event: 'TELEGRAM_SENDER_TELEMETRY',
    project: 'ROBIN',
    pid: process.pid,
    category: input.category,
    delivered: input.delivered,
    tokenEnvKey: credentials.tokenEnvKey,
    destinationEnvKey: credentials.destinationEnvKey,
    tokenHash: maskedTokenHash(credentials.token),
    destinationHash: input.destination === undefined ? null : sha256(input.destination),
    timestamp: new Date().toISOString(),
    telegramMessageId: input.messageId ?? null,
    failureReason: input.failureReason ?? null,
  }) + '\n');
}

export async function sendRobinProjectMessage(
  text: string,
  category: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ delivered: boolean; messageId: number | null }> {
  const credentials = resolveRobinTelegramCredentials();
  if (!credentials.token || !credentials.destination) {
    emitRobinSenderTelemetry({
      delivered: false,
      category,
      destination: credentials.destination,
      failureReason: 'PROJECT_CREDENTIAL_OR_DESTINATION_MISSING',
    });
    return { delivered: false, messageId: null };
  }
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${credentials.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: credentials.destination, text }),
    });
    const payload = await response.json().catch(() => null) as { result?: { message_id?: number } } | null;
    const messageId = payload?.result?.message_id ?? null;
    emitRobinSenderTelemetry({
      delivered: response.ok,
      category,
      destination: credentials.destination,
      messageId,
      failureReason: response.ok ? null : `HTTP_${response.status}`,
    });
    return { delivered: response.ok, messageId };
  } catch (error) {
    emitRobinSenderTelemetry({
      delivered: false,
      category,
      destination: credentials.destination,
      failureReason: 'TRANSPORT_ERROR',
    });
    throw error;
  }
}

export function installRobinBotSenderTelemetry(bot: Bot): void {
  bot.api.config.use(async (prev, method, payload, signal) => {
    try {
      const result = await prev(method, payload, signal);
      if (method === 'sendMessage') {
        const response = result as { message_id?: number; result?: { message_id?: number } };
        emitRobinSenderTelemetry({
          delivered: true,
          category: 'telegram_bot_send_message',
          destination: (payload as { chat_id?: string | number }).chat_id,
          messageId: response?.message_id ?? response?.result?.message_id ?? null,
        });
      }
      return result;
    } catch (error) {
      if (method === 'sendMessage') {
        emitRobinSenderTelemetry({
          delivered: false,
          category: 'telegram_bot_send_message',
          destination: (payload as { chat_id?: string | number }).chat_id,
          failureReason: 'TRANSPORT_ERROR',
        });
      }
      throw error;
    }
  });
}
