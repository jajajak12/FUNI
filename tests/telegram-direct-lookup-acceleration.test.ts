import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { needsDirectLookupAcceleration } from "../apps/telegram-lp-bot/src/direct-lookup-acceleration.js";

const rows=(count:number,uiState:string,executionEligible=false)=>Array.from({length:count},()=>({uiState,executionEligible}));

describe("explicit Telegram CA freshness acceleration",()=>{
  it("accelerates stale supported candidates while preserving fresh executable truth",()=>{
    expect(needsDirectLookupAcceleration([...rows(58,"CHECKING"),...rows(30,"UNSUPPORTED:NONZERO_HOOK_UNSUPPORTED")])).toMatchObject({cachedCandidateCount:88,freshExecutableCount:0,staleSupportedCount:58,unsupportedCount:30,accelerationNeeded:true});
    expect(needsDirectLookupAcceleration([...rows(1,"EXECUTABLE",true),...rows(30,"CHECKING")])).toMatchObject({freshExecutableCount:1,staleSupportedCount:30,accelerationNeeded:true});
  });
  it("does not accelerate fresh-classified or unsupported-only universes",()=>{
    expect(needsDirectLookupAcceleration([...rows(4,"EXECUTABLE",true),...rows(3,"SUPPORTED_NO_ACTIVE_LIQUIDITY")])).toMatchObject({accelerationNeeded:false,reason:"SUPPORTED_TRUTH_FRESH"});
    expect(needsDirectLookupAcceleration(rows(30,"UNSUPPORTED:DYNAMIC_FEE_UNSUPPORTED"))).toMatchObject({accelerationNeeded:false,reason:"UNSUPPORTED_ONLY"});
  });
  it("preserves the existing discovery/direct lookup behavior when no rows exist",()=>{
    expect(needsDirectLookupAcceleration([])).toMatchObject({accelerationNeeded:true,reason:"NO_REGISTRY_ROWS"});
  });
  it("makes same-token paste and Refresh use the canonical decision and durable request reuse",()=>{
    const source=readFileSync("apps/telegram-lp-bot/src/index.ts","utf8"),begin=source.slice(source.indexOf("async function beginToken"),source.indexOf("function renderPoolListing"));
    expect(begin.indexOf("needsDirectLookupAcceleration(allV4)")).toBeLessThan(begin.indexOf("telegram_pool_lookup_reused"));
    expect(begin).toContain("explicitRetry: false");
    expect(source).toContain("await beginToken(ctx, ctx.match[1]!);\n});\nbot.callbackQuery(/^pool:");
  });
  it("keeps fresh executable cache visible when accelerator terminal delivery fails",()=>{
    const source=readFileSync("apps/telegram-lp-bot/src/index.ts","utf8"),outbox=source.slice(source.indexOf("async function deliverDirectLookupOutbox"),source.indexOf("async function directLookupOutboxConsumer"));
    expect(outbox).toContain("freshExecutable.length");
    expect(outbox.indexOf("freshExecutable.length")).toBeLessThan(outbox.lastIndexOf("terminalLookupRender(payload.terminalStatus"));
  });
});
