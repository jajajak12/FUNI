import { sanitizeSensitiveText } from '@funi/core';

const tokenPattern=/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g;
export function safeTelegramOperation(ctx:any){const callback=typeof ctx?.callbackQuery?.data==='string'?ctx.callbackQuery.data.split(':',1)[0]:undefined;return callback??(ctx?.message?'message':'telegram_update');}
export function safeTelegramError(error:unknown){const value=error as {name?:unknown;code?:unknown;message?:unknown};return {errorName:typeof value?.name==='string'?value.name:'Error',errorCode:typeof value?.code==='string'?value.code:undefined,errorMessage:sanitizeSensitiveText(String(value?.message??error).replace(tokenPattern,'[REDACTED]')).slice(0,300)};}
