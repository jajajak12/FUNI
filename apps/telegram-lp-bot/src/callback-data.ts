export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

export class TelegramCallbackDataOverflowError extends Error {
  readonly code = "TELEGRAM_CALLBACK_DATA_OVERFLOW";
  readonly prefix: string;
  readonly byteLength: number;
  constructor(
    prefix: string,
    byteLength: number,
  ) {
    super(`TELEGRAM_CALLBACK_DATA_OVERFLOW prefix=${prefix} bytes=${byteLength} max=${TELEGRAM_CALLBACK_DATA_MAX_BYTES}`);
    this.name = "TelegramCallbackDataOverflowError";
    this.prefix = prefix;
    this.byteLength = byteLength;
  }
}

export function telegramCallbackData(data: string): string {
  const byteLength = Buffer.byteLength(data, "utf8");
  if (byteLength > TELEGRAM_CALLBACK_DATA_MAX_BYTES)
    throw new TelegramCallbackDataOverflowError(data.split(":", 1)[0] ?? "", byteLength);
  return data;
}

const bidLadderActionCodes = {
  view: "v",
  livePreview: "op",
  liveOpen: "oo",
  closePreview: "cp",
  closeConfirm: "cc",
  collectPreview: "fp",
  collectConfirm: "fc",
  collectCancel: "fx",
  repositionPreview: "rp",
  repositionConfirm: "rc",
  repositionPrepareAllowance: "ra",
  repositionCancel: "rx",
  repositionStop: "rs",
} as const;

export type BidLadderCallbackAction = keyof typeof bidLadderActionCodes;

export function bidLadderCallback(action: BidLadderCallbackAction, ladderId: string, authorizationId?: string): string {
  if (authorizationId !== undefined) {
    if (!['collectConfirm','repositionPreview','repositionConfirm','repositionPrepareAllowance','repositionCancel','repositionStop'].includes(action) || !/^[0-9a-f]{18}$/.test(authorizationId)) throw new Error("BID_LADDER_CALLBACK_AUTHORIZATION_INVALID");
    return telegramCallbackData(`bl:${bidLadderActionCodes[action]}:${authorizationId}:${ladderId}`);
  }
  if (["collectConfirm","repositionPreview","repositionConfirm","repositionPrepareAllowance","repositionCancel","repositionStop"].includes(action)) throw new Error("BID_LADDER_CALLBACK_AUTHORIZATION_REQUIRED");
  return telegramCallbackData(`bl:${bidLadderActionCodes[action]}:${ladderId}`);
}
