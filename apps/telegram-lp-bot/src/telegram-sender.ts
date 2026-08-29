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

export function resolveFuniTelegramCredentials() {
  const token = process.env.FUNI_TELEGRAM_BOT_TOKEN;
  const destination = process.env.FUNI_TELEGRAM_CHAT_ID;
  return {
    token,
    destination,
    tokenEnvKey: 'FUNI_TELEGRAM_BOT_TOKEN' as const,
    destinationEnvKey: 'FUNI_TELEGRAM_CHAT_ID' as const,
  };
}

export function assertFuniTelegramCredentials() {
  const credentials = resolveFuniTelegramCredentials();
  if (!credentials.token) throw new Error('FUNI_TELEGRAM_BOT_TOKEN is required');
  if (!credentials.destination) throw new Error('FUNI_TELEGRAM_CHAT_ID is required');
  return {
    ...credentials,
    token: credentials.token,
    destination: credentials.destination,
  };
}

export function emitFuniSenderTelemetry(input: TelemetryInput): void {
  const credentials = resolveFuniTelegramCredentials();
  process.stdout.write(JSON.stringify({
    event: 'TELEGRAM_SENDER_TELEMETRY',
    project: 'FUNI',
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

export async function sendFuniMessage(
  text: string,
  category: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ delivered: boolean; messageId: number | null; retryable?: boolean; failureCode?: string }> {
  const credentials = resolveFuniTelegramCredentials();
  if (!credentials.token || !credentials.destination) {
    emitFuniSenderTelemetry({
      delivered: false,
      category,
      destination: credentials.destination,
      failureReason: 'PROJECT_CREDENTIAL_OR_DESTINATION_MISSING',
    });
    return { delivered: false, messageId: null, retryable: false, failureCode: 'TELEGRAM_DESTINATION_OR_CONFIGURATION_INVALID' };
  }
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${credentials.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: credentials.destination, text }),
    });
    const payload = await response.json().catch(() => null) as { result?: { message_id?: number } } | null;
    const messageId = payload?.result?.message_id ?? null;
    emitFuniSenderTelemetry({
      delivered: response.ok,
      category,
      destination: credentials.destination,
      messageId,
      failureReason: response.ok ? null : `HTTP_${response.status}`,
    });
    return response.ok
      ? { delivered: true, messageId }
      : { delivered: false, messageId, retryable: response.status === 429 || response.status >= 500, failureCode: response.status === 429 || response.status >= 500 ? 'TELEGRAM_TRANSIENT_DELIVERY_FAILURE' : 'TELEGRAM_DESTINATION_OR_CONFIGURATION_INVALID' };
  } catch (error) {
    emitFuniSenderTelemetry({
      delivered: false,
      category,
      destination: credentials.destination,
      failureReason: 'TRANSPORT_ERROR',
    });
    throw error;
  }
}

export async function sendFuniPhoto(
  png: Buffer,
  caption: string,
  category: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ delivered: boolean; messageId: number | null; retryable?: boolean; failureCode?: string }> {
  const credentials = resolveFuniTelegramCredentials();
  if (!credentials.token || !credentials.destination)
    return { delivered: false, messageId: null, retryable: false, failureCode: "TELEGRAM_DESTINATION_OR_CONFIGURATION_INVALID" };
  try {
    const form = new FormData(); form.set("chat_id", credentials.destination); form.set("caption", caption); form.set("photo", new Blob([png], { type: "image/png" }), "funi-pnl.png");
    const response = await fetchImpl(`https://api.telegram.org/bot${credentials.token}/sendPhoto`, { method: "POST", body: form });
    const payload = await response.json().catch(() => null) as { result?: { message_id?: number } } | null, messageId=payload?.result?.message_id??null;
    emitFuniSenderTelemetry({ delivered: response.ok, category, destination: credentials.destination, messageId, failureReason: response.ok?null:`HTTP_${response.status}` });
    return response.ok ? {delivered:true,messageId} : {delivered:false,messageId,retryable:response.status===429||response.status>=500,failureCode:response.status===429||response.status>=500?"TELEGRAM_TRANSIENT_DELIVERY_FAILURE":"TELEGRAM_DESTINATION_OR_CONFIGURATION_INVALID"};
  } catch (error) { emitFuniSenderTelemetry({delivered:false,category,destination:credentials.destination,failureReason:"TRANSPORT_ERROR"}); throw error; }
}

export function installFuniBotSenderTelemetry(bot: Bot): void {
  bot.api.config.use(async (prev, method, payload, signal) => {
    try {
      const result = await prev(method, payload, signal);
      if (method === 'sendMessage') {
        const response = result as { message_id?: number; result?: { message_id?: number } };
        emitFuniSenderTelemetry({
          delivered: true,
          category: 'telegram_bot_send_message',
          destination: (payload as { chat_id?: string | number }).chat_id,
          messageId: response?.message_id ?? response?.result?.message_id ?? null,
        });
      }
      return result;
    } catch (error) {
      if (method === 'sendMessage') {
        emitFuniSenderTelemetry({
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
