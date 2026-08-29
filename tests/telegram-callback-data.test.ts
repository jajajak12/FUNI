import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bidLadderCallback, telegramCallbackData, type BidLadderCallbackAction } from '../apps/telegram-lp-bot/src/callback-data.js';
import { chainActionButton, chainSelectorView } from '../apps/telegram-lp-bot/src/multichain-ux.js';

const ladderId = `v4bid_${'f'.repeat(32)}`;

describe('Telegram callback_data byte invariant', () => {
  it('keeps every emitted Bid Ladder action within Telegram’s UTF-8 limit and matches its route', () => {
    const routes = {
      view: /^bl:v:v4bid_[0-9a-f]{32}$/,
      livePreview: /^bl:op:v4bid_[0-9a-f]{32}$/,
      liveOpen: /^bl:oo:v4bid_[0-9a-f]{32}$/,
      closePreview: /^bl:cp:v4bid_[0-9a-f]{32}$/,
      closeConfirm: /^bl:cc:v4bid_[0-9a-f]{32}$/,
      collectPreview: /^bl:fp:v4bid_[0-9a-f]{32}$/,
      collectCancel: /^bl:fx:v4bid_[0-9a-f]{32}$/,
    } satisfies Partial<Record<BidLadderCallbackAction, RegExp>>;
    for (const [action, route] of Object.entries(routes)) {
      const data = bidLadderCallback(action as BidLadderCallbackAction, ladderId);
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
      expect(data).toMatch(route);
    }
    for(const action of ['repositionPreview','repositionConfirm','repositionPrepareAllowance','repositionCancel','repositionStop'] as const){const data=bidLadderCallback(action,ladderId,'b'.repeat(18));expect(Buffer.byteLength(data,'utf8')).toBe(63);}
    const collect = bidLadderCallback('collectConfirm', ladderId, 'a'.repeat(18));
    expect(Buffer.byteLength(collect, 'utf8')).toBeLessThanOrEqual(64);
    expect(collect).toMatch(/^bl:fc:[0-9a-f]{18}:v4bid_[0-9a-f]{32}$/);
    expect(() => bidLadderCallback('collectConfirm', ladderId)).toThrow('BID_LADDER_CALLBACK_AUTHORIZATION_REQUIRED');
    expect(() => bidLadderCallback('repositionPreview', ladderId)).toThrow('BID_LADDER_CALLBACK_AUTHORIZATION_REQUIRED');
  });

  it('guards every bot callback producer and rejects oversize UTF-8 payloads deterministically', () => {
    const source = readFileSync('apps/telegram-lp-bot/src/index.ts', 'utf8');
    expect(source).toContain('telegramCallbackData(data)');
    expect(source).toContain('telegram_callback_data_overflow');
    expect(source).not.toMatch(/bid-ladder-(?:view|live-preview|live-open|close-preview|close-confirm|reposition-preview|reposition-confirm|reposition-cancel):/);
    expect(() => telegramCallbackData(`x:${'😀'.repeat(16)}`)).toThrow(/TELEGRAM_CALLBACK_DATA_OVERFLOW prefix=x bytes=66 max=64/);
    const direct = [
      ...chainSelectorView({}).keyboard.flat().map(item => item.callback_data),
      ...chainActionButton({ chainId: 1, protocol: 'uniswap_v3', action: 'close', authorizationId: 'a'.repeat(40), executionReady: true }).keyboard.flat().map(item => item.callback_data),
      'pnl-period:daily',
      'pnl-period:weekly',
      'pnl-period:monthly',
    ];
    for (const data of direct) expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    expect(source).toContain('pnl-period:daily');
    expect(source).toContain('pnl-period:weekly');
    expect(source).toContain('pnl-period:monthly');
    expect(source).toContain('/^pnl-period:(daily|weekly|monthly)$/');
  });
});
