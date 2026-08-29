export const isGroupChat=(type:unknown)=>type==='group'||type==='supergroup';
export const isChatIdCommand=(text:unknown)=>typeof text==='string'&&/^\/chatid(?:@[A-Za-z0-9_]+)?\s*$/.test(text.trim());
export type TelegramInboundEnvelope={
 chatType:unknown;
 senderId?:unknown;
 chatId?:unknown;
 operatorUserId:string;
 operatorPrivateChatId:string;
 updateKind?:unknown;
 isReply?:boolean;
 isForward?:boolean;
 isMention?:boolean;
};
/** The group destination is deliberately absent from this authorization
 * contract. Only an ordinary private message/callback from the one bound
 * operator identity and the one bound private chat may reach Grammy's
 * command or callback routing. */
export function authorizeTelegramInbound(input:TelegramInboundEnvelope){
 const ordinary=input.updateKind==='message'||input.updateKind==='callback_query';
 const disallowedMessageShape=input.updateKind==='message'&&(input.isReply||input.isForward||input.isMention);
 return ordinary&&!disallowedMessageShape&&input.chatType==='private'&&String(input.senderId??'')===input.operatorUserId&&String(input.chatId??'')===input.operatorPrivateChatId?'authorized' as const:'silent' as const;
}
export function telegramMessageShape(message:Record<string,unknown>|undefined){
 const entities=Array.isArray(message?.entities)?message.entities as Array<Record<string,unknown>>:[];
 return {
  isReply:Boolean(message?.reply_to_message),
  isForward:Boolean(message?.forward_origin||message?.forward_date||message?.forward_from||message?.forward_from_chat),
  isMention:entities.some(entity=>entity.type==='mention'||entity.type==='text_mention')||/@[A-Za-z0-9_]+/.test(String(message?.text??'')),
 };
}
export function telegramUpdateKind(update:Record<string,unknown>|undefined){
 if(update?.edited_message)return 'edited_message' as const;
 if(update?.channel_post)return 'channel_post' as const;
 if(update?.edited_channel_post)return 'edited_channel_post' as const;
 if(update?.callback_query)return 'callback_query' as const;
 if(update?.message)return 'message' as const;
 return 'unsupported' as const;
}
export function groupInboundRoute(input:{chatType:unknown;text?:unknown;authorized:boolean}){return isGroupChat(input.chatType)?'silent' as const:'private_or_other' as const;}
