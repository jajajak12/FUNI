import { describe,expect,it } from 'vitest';
import { shouldPreserveBotOperationalPosition } from '../apps/cli/src/position-adoption.js';

describe('adoption merge provenance',()=>{
 it('preserves bot-operational positions and never replaces their provenance',()=>{expect(shouldPreserveBotOperationalPosition({open_intent_id:'intent-1'})).toBe(true);expect(shouldPreserveBotOperationalPosition({open_intent_id:null})).toBe(false);});
});
