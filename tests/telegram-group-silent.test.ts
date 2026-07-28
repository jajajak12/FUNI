import { describe, expect, it } from 'vitest';
import { groupInboundRoute } from '../apps/telegram-lp-bot/src/group-silent.js';
describe('Telegram group silent routing',()=>{
 it('silences ordinary text, mentions, replies, service-like text, and unauthorized commands',()=>{for(const text of ['hello','@robin hello','0xC2362AfF2A2a4CC1f48cF3Dab2C4e2605eb94BA3','/chatid','/unknown'])expect(groupInboundRoute({chatType:'group',text,authorized:false})).toBe('silent');expect(groupInboundRoute({chatType:'supergroup',authorized:true})).toBe('silent');});
 it('allows only authorized group chatid including bot suffix',()=>{expect(groupInboundRoute({chatType:'group',text:'/chatid',authorized:true})).toBe('authorized_chatid');expect(groupInboundRoute({chatType:'supergroup',text:'/chatid@robin_bot',authorized:true})).toBe('authorized_chatid');});
 it('leaves private authorized CA flow routable',()=>expect(groupInboundRoute({chatType:'private',text:'0xC2362AfF2A2a4CC1f48cF3Dab2C4e2605eb94BA3',authorized:true})).toBe('private_or_other'));
});
