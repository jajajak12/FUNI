import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { needsDirectLookupAcceleration } from "../apps/telegram-lp-bot/src/direct-lookup-acceleration.js";
import { directLookupAcknowledgementText, poolListingSummary, type PoolListing } from "../apps/telegram-lp-bot/src/pool-selection-ux.js";

const rows=(count:number,uiState:string,executionEligible=false)=>Array.from({length:count},()=>({uiState,executionEligible}));

describe("explicit Telegram CA freshness acceleration",()=>{
  it("accelerates stale supported candidates while preserving fresh executable truth",()=>{
    expect(needsDirectLookupAcceleration([...rows(58,"CHECKING"),...rows(30,"UNSUPPORTED:NONZERO_HOOK_UNSUPPORTED")])).toMatchObject({cachedCandidateCount:88,freshExecutableCount:0,staleSupportedCount:58,unsupportedCount:30,accelerationNeeded:true});
    expect(needsDirectLookupAcceleration([...rows(1,"EXECUTABLE",true),...rows(30,"CHECKING")])).toMatchObject({freshExecutableCount:1,staleSupportedCount:30,accelerationNeeded:true});
    expect(needsDirectLookupAcceleration(rows(14,"NOT_INITIALIZED"))).toMatchObject({staleSupportedCount:14,accelerationNeeded:true});
  });
  it("keeps the production-shaped 37-pool set bounded and fully classified",()=>{
    const candidates=[...rows(15,"CHECKING"),...rows(22,"UNSUPPORTED:NONZERO_HOOK_UNSUPPORTED")],result=needsDirectLookupAcceleration(candidates);
    expect(result).toMatchObject({cachedCandidateCount:37,freshExecutableCount:0,staleSupportedCount:15,unsupportedCount:22,accelerationNeeded:true});
    const counts={v4Eligible:0,v3Eligible:0,v4Unavailable:37,zeroLiquidity:0,checking:15,unsupported:22,evidenceUnavailable:0,notInitialized:0},listing:PoolListing={tokenSymbol:"TOKEN",tokenAddress:"0x0000000000000000000000000000000000000042",items:[],unavailableItems:Array.from({length:37},(_,index)=>({section:"v4_unavailable" as const,label:`pool-${index}`,data:`pool:${index}`})),counts},progress:number[]=[],cached:number[]=[],complete:number[]=[];
    for(let index=0;index<500;index++){
      let started=performance.now();directLookupAcknowledgementText(listing.tokenSymbol,listing.tokenAddress,counts);progress.push(performance.now()-started);
      started=performance.now();needsDirectLookupAcceleration(candidates);cached.push(performance.now()-started);
      started=performance.now();poolListingSummary(listing,0);complete.push(performance.now()-started);
    }
    const summary=(samples:number[])=>{samples.sort((a,b)=>a-b);return {p50Ms:samples[Math.ceil(samples.length*.5)-1],p95Ms:samples[Math.ceil(samples.length*.95)-1],maxMs:samples.at(-1)};};
    console.log(JSON.stringify({event:"public_telegram_37_pool_render_performance",samples:500,progressFirstPaint:summary(progress),cachedResultPaint:summary(cached),completeResultPaint:summary(complete)}));
  });
  it("does not accelerate fresh-classified or unsupported-only universes",()=>{
    expect(needsDirectLookupAcceleration([...rows(4,"EXECUTABLE",true),...rows(3,"SUPPORTED_NO_ACTIVE_LIQUIDITY")])).toMatchObject({accelerationNeeded:false,reason:"SUPPORTED_TRUTH_FRESH"});
    expect(needsDirectLookupAcceleration(rows(30,"UNSUPPORTED:DYNAMIC_FEE_UNSUPPORTED"))).toMatchObject({accelerationNeeded:false,reason:"UNSUPPORTED_ONLY"});
  });
  it("preserves the existing discovery/direct lookup behavior when no rows exist",()=>{
    expect(needsDirectLookupAcceleration([])).toMatchObject({accelerationNeeded:true,reason:"NO_REGISTRY_ROWS"});
  });
  it("makes token paste and Refresh use the canonical decision and durable request reuse",()=>{
    const source=readFileSync("apps/telegram-lp-bot/src/index.ts","utf8"),begin=source.slice(source.indexOf("async function beginToken"),source.indexOf("function renderPoolListing"));
    expect(begin).toContain("needsDirectLookupAcceleration(allV4)");
    expect(begin.indexOf('ctx.reply(`${tokenAddress}\\nChecking cached eligible pools…`)')).toBeLessThan(begin.indexOf("cachedV4PoolsForToken"));
    expect(begin).toContain("explicitRetry: false");
    expect(source).toContain("await beginToken(ctx, ctx.match[1]!);\n});\nbot.callbackQuery(/^pool:");
  });
  it("keeps fresh executable cache visible when accelerator terminal delivery fails",()=>{
    const source=readFileSync("apps/telegram-lp-bot/src/index.ts","utf8"),outbox=source.slice(source.indexOf("async function deliverDirectLookupOutbox"),source.indexOf("async function directLookupOutboxConsumer"));
    expect(outbox).toContain("freshExecutable.length");
    expect(outbox.indexOf("freshExecutable.length")).toBeLessThan(outbox.lastIndexOf("terminalLookupRender(payload.terminalStatus"));
  });
  it("acknowledges the natural paste before durable request work and renders the exact outbox revision",()=>{
    const source=readFileSync("apps/telegram-lp-bot/src/index.ts","utf8"),begin=source.slice(source.indexOf("async function beginToken"),source.indexOf("function renderPoolListing")),outbox=source.slice(source.indexOf("async function deliverDirectLookupOutbox"),source.indexOf("async function directLookupOutboxConsumer"));
    expect(begin.indexOf("directLookupAcknowledgementText")).toBeLessThan(begin.indexOf('operation: "createOrReuseDirectLookup"'));
    expect(begin).toContain("telegram_direct_lookup_first_response");expect(begin).toContain("telegram_direct_lookup_request_persisted");expect(begin).toContain("naturalTimeline:{pasteReceivedAtMs,firstUiResponseAtMs}");
    expect(source).toContain('SELECT symbol,name FROM gmgn_robinhood_observations');expect(source).toContain('directLookupTargetSymbol');
    expect(outbox).toContain("requestId:String(payload.requestId),requestRevision:Number(payload.requestRevision)");expect(outbox).toContain("eligible.has(item.poolId.toLowerCase())");expect(outbox).toContain("telegramListingCompleteAtMs");
  });
  it("retires only genuinely superseded interactive keyboards without blocking the new flow",()=>{
    const source=readFileSync("apps/telegram-lp-bot/src/index.ts","utf8"),helpers=source.slice(source.indexOf("function supersededFlowMessageIds"),source.indexOf("function selectionIdentity")),begin=source.slice(source.indexOf("async function beginToken"),source.indexOf("function renderPoolListing")),outbox=source.slice(source.indexOf("async function deliverDirectLookupOutbox"),source.indexOf("async function directLookupOutboxConsumer"));
    expect(helpers).toContain("editMessageReplyMarkup");
    expect(helpers).toContain("inline_keyboard:[]");
    expect(helpers).toContain("void Promise.race");
    expect(helpers).toContain("TELEGRAM_FLOW_UI_RETIRE_TIMEOUT");
    expect(helpers.indexOf("const flow=newFlow")).toBeLessThan(helpers.indexOf("retireSupersededFlowUi(ctx,previous)"));
    expect(begin.indexOf("newTokenFlow(ctx")).toBeLessThan(begin.indexOf("cachedV4PoolsForToken"));
    expect(outbox).not.toContain("retireSupersededFlowUi");
    expect(source).toContain("backendStaleRejectionAuthoritative:true");
  });
  it("uses one progress message and revision-scoped latest-work authority for corrected amounts",()=>{
    const source=readFileSync("apps/telegram-lp-bot/src/index.ts","utf8"),direct=source.slice(source.indexOf("async function bidLadderDirectLiveOnce"),source.indexOf("async function bidLadderStart"));
    expect(direct).toContain('ctx.reply("Preparing fresh LIVE preview…")');
    expect(direct).toContain("bot.api.editMessageText");
    expect(direct).toContain("bidLadderDirectLiveInFlight.get(key)===request");
    expect(direct).toContain("existing?.updateId===updateId");
    expect(direct).toContain("bot.api.deleteMessage");
  });
});
