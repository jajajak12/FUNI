import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLivePreviewExecutionContext,
  runLivePreviewDeliveryWorkflow,
  type LivePreviewExecutionContext,
} from "../apps/telegram-lp-bot/src/live-preview-lifecycle.js";

type Preview = { blockers:string[] };
const never = <T>() => new Promise<T>(() => undefined);
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function fixture(input:{
  hardDeadlineMs?:number;
  current?:()=>boolean;
  liquidity?:Promise<string>;
  compute?:(signal:AbortSignal)=>Promise<Preview>;
  persist?:(value:Preview,signal:AbortSignal)=>Promise<void>;
  deliver?:(rendered:{text:string;confirm:boolean},signal:AbortSignal)=>Promise<unknown>;
  deliverFailure?:(text:string,signal:AbortSignal)=>Promise<unknown>;
  persistTerminal?:(phase:string)=>void;
}={}) {
  const events:Array<{event:string;data:Record<string,unknown>}>=[], delivered:string[]=[], failures:string[]=[],
    execution=createLivePreviewExecutionContext({
      sessionId:"session",flowRevision:5,requestId:"session:5:1",poolId:`0x${"1".repeat(64)}`,amountIdentity:"0xfunding:2000000000",
      hardDeadlineMs:input.hardDeadlineMs??1_600,isCurrent:input.current??(()=>true),telemetry:(event,data)=>events.push({event,data}),
    }),
    workflow=runLivePreviewDeliveryWorkflow({
      execution,
      liquidity:input.liquidity,
      compute:input.compute??(async()=>({blockers:[]})),
      persistComputed:input.persist??(async()=>undefined),
      render:(preview,liquidityLine)=>({text:liquidityLine,confirm:preview.blockers.length===0}),
      deliver:input.deliver??(async rendered=>{delivered.push(rendered.text);return true;}),
      deliverFailure:input.deliverFailure??(async text=>{failures.push(text);return true;}),
      computedOutcome:preview=>preview.blockers.length?"EXPLICIT_FAIL_CLOSED":"AUTHORITATIVE_LIVE_PREVIEW",
      failureText:(_error,timedOut)=>timedOut?"LIVE PREVIEW TIMED OUT\n\nNo transaction was prepared or sent.\nPlease retry.":"LIVE PREVIEW FAILED CLOSED",
      persistTerminal:terminal=>input.persistTerminal?.(terminal.phase),
    });
  return {execution,workflow,events,delivered,failures};
}

afterEach(()=>{vi.useRealTimers();});

describe("bounded LIVE preview root lifecycle",()=>{
  it("awaits the production preview Promise before either caller safety finally can terminalize",async()=>{
    let settle!:(value:Preview)=>void,innerSettled=false,outerTerminalizations=0;
    const value=fixture({compute:()=>new Promise(resolve=>{settle=resolve;})});
    const bidLadderLivePreview=async()=>value.workflow.finally(()=>{innerSettled=true;});
    const bidLadderDirectLiveOnce=async()=>{try{return await bidLadderLivePreview();}finally{if(!value.execution.terminal){outerTerminalizations++;value.execution.terminalize("DELIVERY_FAILED","EXPLICIT_FAIL_CLOSED","DIRECT_PREVIEW_UNEXPECTED_NONTERMINAL_EXIT");}}};
    const bidLadderDirectLive=async()=>{const work=bidLadderDirectLiveOnce();try{return await work;}finally{if(!value.execution.terminal){outerTerminalizations++;value.execution.terminalize("DELIVERY_FAILED","EXPLICIT_FAIL_CLOSED","DIRECT_PREVIEW_IN_FLIGHT_FINALLY");}}};
    const productionChain=bidLadderDirectLive();
    await flush();
    expect(value.execution.terminal).toBeUndefined();
    expect(innerSettled).toBe(false);
    settle({blockers:[]});
    await expect(productionChain).resolves.toMatchObject({phase:"DELIVERED",outcome:"AUTHORITATIVE_LIVE_PREVIEW"});
    expect({innerSettled,outerTerminalizations,deliveries:value.delivered.length}).toEqual({innerSettled:true,outerTerminalizations:0,deliveries:1});
  });

  it("protects the production wrapper against returning the inner Promise without await",()=>{
    const source=readFileSync("apps/telegram-lp-bot/src/index.ts","utf8"),
      direct=source.slice(source.indexOf("async function bidLadderDirectLiveOnce"),source.indexOf("async function bidLadderDirectLive(ctx"));
    expect(direct).toMatch(/return await bidLadderLivePreview\(/);
    expect(direct).not.toMatch(/return\s+bidLadderLivePreview\(/);
    expect(direct).not.toMatch(/return\s+failClosed\(/);
  });

  it("hard-terminalizes a never-settling production-shaped inner Promise independently",async()=>{
    vi.useFakeTimers();
    let settle!:(value:string)=>void,callerSettled=false;
    const execution=createLivePreviewExecutionContext({sessionId:"session",flowRevision:5,requestId:"session:5:hard",poolId:`0x${"3".repeat(64)}`,amountIdentity:"0xfunding:2000000000",hardDeadlineMs:15_000,isCurrent:()=>true}),
      inner=new Promise<string>(resolve=>{settle=resolve;}),
      caller=(async()=>{try{return await inner;}finally{callerSettled=true;if(!execution.terminal)execution.terminalize("DELIVERY_FAILED","EXPLICIT_FAIL_CLOSED","DIRECT_PREVIEW_UNEXPECTED_NONTERMINAL_EXIT");}})();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(execution.terminal).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(execution.terminal).toMatchObject({phase:"FAILED",code:"LIVE_PREVIEW_HARD_DEADLINE"});
    expect(execution.signal.aborted).toBe(true);
    expect(callerSettled).toBe(false);
    settle("late result");
    await expect(caller).resolves.toBe("late result");
    expect(callerSettled).toBe(true);
    expect(execution.terminal?.code).toBe("LIVE_PREVIEW_HARD_DEADLINE");
  });
  it("paints progress and exits normally when a post-preview Telegram Promise never resolves",async()=>{
    vi.useFakeTimers();
    const inFlight=new Map<string,Promise<unknown>>(),economic={signing:0,broadcast:0,journal:0,confirm:false},
      execution=createLivePreviewExecutionContext({sessionId:"session",flowRevision:5,requestId:"session:5:never",poolId:`0x${"2".repeat(64)}`,amountIdentity:"0xfunding:2000000000",hardDeadlineMs:1_600,isCurrent:()=>true}),
      progress:string[]=[];
    await execution.run("TELEGRAM_PREVIEW_PROGRESS_PAINT",async()=>{progress.push("Preparing fresh LIVE preview…");return true;},{maxMs:100});
    const workflow=runLivePreviewDeliveryWorkflow({
      execution,liquidity:Promise.resolve("Pool liquidity: $42K"),compute:async()=>({blockers:[]}),persistComputed:async()=>undefined,
      render:()=>{economic.confirm=true;return "Confirm Live Open";},deliver:async()=>never(),deliverFailure:async()=>{economic.confirm=false;return true;},
      computedOutcome:()=>"AUTHORITATIVE_LIVE_PREVIEW",failureText:()=>"LIVE PREVIEW TIMED OUT\n\nNo transaction was prepared or sent.\nPlease retry.",
    }).finally(()=>inFlight.delete("request"));
    inFlight.set("request",workflow);
    await vi.advanceTimersByTimeAsync(700);
    const terminal=await workflow;
    expect(progress).toEqual(["Preparing fresh LIVE preview…"]);
    expect(terminal).toMatchObject({phase:"FAILED",outcome:"EXPLICIT_FAIL_CLOSED"});
    expect(economic).toEqual({signing:0,broadcast:0,journal:0,confirm:false});
    expect(inFlight.size).toBe(0);
    expect(execution.cleanupPending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["normal response",()=>Promise.resolve("Pool liquidity: $42K")],
    ["never resolves",()=>never<string>()],
    ["rejects",()=>Promise.reject(new Error("DEX_REJECTED"))],
  ])("keeps DexScreener display-only when it %s",async(_name,liquidity)=>{
    const value=fixture({liquidity:liquidity()});
    await expect(value.workflow).resolves.toMatchObject({phase:"DELIVERED",outcome:"AUTHORITATIVE_LIVE_PREVIEW"});
    expect(value.delivered).toHaveLength(1);
    expect(value.execution.terminal?.phase).toBe("DELIVERED");
  });

  it("does not wait for the DexScreener 4s timeout",async()=>{
    vi.useFakeTimers();
    const liquidity=new Promise<string>(resolve=>setTimeout(()=>resolve("Pool liquidity: Unavailable"),4_000)),value=fixture({hardDeadlineMs:1_600,liquidity});
    await expect(value.workflow).resolves.toMatchObject({phase:"DELIVERED",outcome:"AUTHORITATIVE_LIVE_PREVIEW"});
    expect(value.delivered).toEqual(["Pool liquidity: Unavailable"]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(value.events.some(event=>event.data.outcome==="DISCARDED_AFTER_COMPUTE")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses liquidity only if it resolves before compute and discards results after compute",async()=>{
    let finishCompute!:()=>void,finishLate!: (value:string)=>void;
    const early=fixture({liquidity:Promise.resolve("Pool liquidity: $10K"),compute:()=>new Promise(resolve=>{finishCompute=()=>resolve({blockers:[]});})});
    await flush();finishCompute();await early.workflow;
    expect(early.delivered).toEqual(["Pool liquidity: $10K"]);
    const late=fixture({liquidity:new Promise(resolve=>{finishLate=resolve;})});
    await late.workflow;finishLate("Pool liquidity: $99K");await flush();
    expect(late.delivered).toEqual(["Pool liquidity: Unavailable"]);
    expect(late.events.some(value=>value.data.outcome==="DISCARDED_AFTER_COMPUTE")).toBe(true);
  });

  it.each(["USER_SUBMITTED_NEW_AMOUNT","USER_CHOSE_ANOTHER_POOL","USER_SENT_NEW_TOKEN","START_OVER","CANCEL"])("discards DexScreener and computation after supersession: %s",async reason=>{
    let resolveLiquidity!:(value:string)=>void;
    const value=fixture({liquidity:new Promise(resolve=>{resolveLiquidity=resolve;}),compute:()=>never()});
    value.execution.supersede(reason);
    await expect(value.workflow).resolves.toMatchObject({phase:"SUPERSEDED",outcome:"SUPERSEDED_NO_OP",code:reason});
    resolveLiquidity("Pool liquidity: $1M");await flush();
    expect(value.delivered).toEqual([]);
    expect(value.failures).toEqual([]);
    expect(value.execution.cleanupPending).toBe(false);
  });

  it("discards DexScreener after the hard deadline",async()=>{
    vi.useFakeTimers();
    let resolveLiquidity!:(value:string)=>void;
    const value=fixture({hardDeadlineMs:1_600,liquidity:new Promise(resolve=>{resolveLiquidity=resolve;}),compute:()=>never()});
    await vi.advanceTimersByTimeAsync(1_600);
    await expect(value.workflow).resolves.toMatchObject({outcome:"EXPLICIT_FAIL_CLOSED"});
    resolveLiquidity("Pool liquidity: $1M");await flush();
    expect(value.delivered).toEqual([]);
    expect(value.execution.terminal).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("covers successful, slow, rejected, and never-resolving final Telegram edits",async()=>{
    vi.useFakeTimers();
    const success=fixture(),slow=fixture({deliver:async(_rendered,signal)=>new Promise((resolve,reject)=>{const timer=setTimeout(resolve,200);signal.addEventListener("abort",()=>{clearTimeout(timer);reject(signal.reason);},{once:true});})}),
      rejected=fixture({deliver:async()=>{throw new Error("TELEGRAM_REJECTED");}}),hung=fixture({deliver:async()=>never()});
    await expect(success.workflow).resolves.toMatchObject({phase:"DELIVERED"});
    await vi.advanceTimersByTimeAsync(200);await expect(slow.workflow).resolves.toMatchObject({phase:"DELIVERED"});
    await expect(rejected.workflow).resolves.toMatchObject({phase:"FAILED",outcome:"EXPLICIT_FAIL_CLOSED"});
    await vi.advanceTimersByTimeAsync(700);await expect(hung.workflow).resolves.toMatchObject({phase:"FAILED",outcome:"EXPLICIT_FAIL_CLOSED"});
    for(const value of [success,slow,rejected,hung])expect(value.execution.cleanupPending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["rejects","never resolves"])("terminalizes when the error edit %s",async mode=>{
    vi.useFakeTimers();
    const value=fixture({compute:async()=>{throw new Error("COMPUTE_FAILED");},deliverFailure:mode==="rejects"?async()=>{throw new Error("ERROR_EDIT_REJECTED");}:async()=>never()});
    await flush();
    if(mode==="never resolves")await vi.advanceTimersByTimeAsync(1_000);
    await expect(value.workflow).resolves.toMatchObject({phase:"FAILED",outcome:"EXPLICIT_FAIL_CLOSED"});
    expect(value.execution.cleanupPending).toBe(false);
    expect(value.events.filter(event=>event.event==="live_preview_terminal_notification")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("persists failure terminalization before exactly one bounded Telegram failure attempt",async()=>{
    const order:string[]=[];
    let attempts=0,phaseAtAttempt:string|undefined;
    const value=fixture({
      compute:async()=>{throw new Error("COMPUTE_FAILED");},
      persistTerminal:phase=>order.push(`persist:${phase}`),
      deliverFailure:async()=>{attempts++;phaseAtAttempt=value.execution.terminal?.phase;order.push(`notify:${phaseAtAttempt}`);return true;},
    });
    await expect(value.workflow).resolves.toMatchObject({phase:"FAILED",outcome:"EXPLICIT_FAIL_CLOSED"});
    expect({attempts,phaseAtAttempt,order}).toEqual({attempts:1,phaseAtAttempt:"FAILED",order:["persist:FAILED","notify:FAILED"]});
  });

  it("persists computation once, never recomputes after delivery failure, and terminalizes exactly once",async()=>{
    let computes=0,persists=0;
    const value=fixture({compute:async()=>{computes++;return {blockers:[]};},persist:async()=>{persists++;},deliver:async()=>{throw new Error("SEND_FAILED");}});
    const terminal=await value.workflow,again=value.execution.terminalize("DELIVERED","AUTHORITATIVE_LIVE_PREVIEW","LATE_CALLBACK");
    expect({computes,persists}).toEqual({computes:1,persists:1});
    expect(again).toBe(terminal);
    expect(value.execution.terminal?.code).not.toBe("LATE_CALLBACK");
  });
});
