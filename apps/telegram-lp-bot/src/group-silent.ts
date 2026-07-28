export const isGroupChat=(type:unknown)=>type==='group'||type==='supergroup';
export const isChatIdCommand=(text:unknown)=>typeof text==='string'&&/^\/chatid(?:@[A-Za-z0-9_]+)?\s*$/.test(text.trim());
export function groupInboundRoute(input:{chatType:unknown;text?:unknown;authorized:boolean}){if(!isGroupChat(input.chatType))return 'private_or_other' as const;return input.authorized&&isChatIdCommand(input.text)?'authorized_chatid':'silent' as const;}
