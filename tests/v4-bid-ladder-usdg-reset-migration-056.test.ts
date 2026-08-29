import Database from "better-sqlite3";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const address = (digit: string) => `0x${digit.repeat(40)}`;
const pool = `0x${"1".repeat(64)}`;

function insertLadder(db: Database.Database, id: string) {
  db.prepare("INSERT INTO v4_bid_ladders(ladder_id,strategy_version,execution_mode,pool_id,currency0,currency1,fee,tick_spacing,hooks,funding_token,target_token,funding_index,target_index,reference_tick,reference_block,total_funding_amount_raw,entry_usd_snapshot,status,created_at_ms,updated_at_ms) VALUES(?,'V4_BID_LADDER_V1','LIVE',?,?,?,?,?,?,?,?,1,0,0,'1','1000000',1,'OPEN',1000,1000)").run(id,pool,address("1"),address("2"),3000,10,address("0"),address("2"),address("1"));
  const leg=db.prepare("INSERT INTO v4_bid_ladder_legs(ladder_id,leg_index,upper_drop_bps,lower_drop_bps,capital_weight_bps,tick_lower,tick_upper,funding_amount_raw,planned_liquidity_raw,funding_index,target_index,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,1,0,'OPEN',1000,1000)");
  const bounds=[[100,500],[500,1200],[1200,2200],[2200,3500],[3500,6000]],weights=[800,1200,1800,2500,3700];
  for(let index=0;index<5;index++)leg.run(id,index,bounds[index]![0],bounds[index]![1],weights[index],index*10,index*10+10,'200000','1');
}

describe("migration 056 USDG Reset Reposition V1",()=>{
  it("upgrades additively without enabling or changing existing ladders",()=>{
    const root=mkdtempSync(join(tmpdir(),"reset-056-upgrade-")),before=join(root,"through-055"),path=join(root,"ledger.sqlite");roots.push(root);mkdirSync(before);
    for(const name of readdirSync("infra/migrations"))if(/^\d{3}_/.test(name)&&Number(name.slice(0,3))<=55)cpSync(join("infra/migrations",name),join(before,name));
    migrateSqlite(path,before);let db=new Database(path);insertLadder(db,"legacy");const beforeCounts={parents:Number((db.prepare("SELECT COUNT(*) count FROM v4_bid_ladders").get() as any).count),legs:Number((db.prepare("SELECT COUNT(*) count FROM v4_bid_ladder_legs").get() as any).count)};db.close();
    migrateSqlite(path,"infra/migrations");db=new Database(path);try{expect(db.prepare("SELECT * FROM v4_bid_ladder_usdg_reset_v1").all()).toEqual([]);expect(db.prepare("SELECT COUNT(*) count FROM v4_bid_ladders").get()).toEqual({count:beforeCounts.parents});expect(db.prepare("SELECT COUNT(*) count FROM v4_bid_ladder_legs").get()).toEqual({count:beforeCounts.legs});expect(db.pragma("integrity_check",{simple:true})).toBe("ok");expect(db.pragma("foreign_key_check")).toEqual([]);}finally{db.close();}
  });

  it("enforces generation, link, FK, and decimal raw amount invariants",()=>{
    const root=mkdtempSync(join(tmpdir(),"reset-056-constraints-")),path=join(root,"ledger.sqlite");roots.push(root);migrateSqlite(path,"infra/migrations");const db=new Database(path);db.pragma("foreign_keys=ON");try{
      for(const id of ["root","child","other"])insertLadder(db,id);
      const insert=db.prepare("INSERT INTO v4_bid_ladder_usdg_reset_v1(ladder_id,root_ladder_id,previous_ladder_id,next_ladder_id,generation,policy,creation_reason,phase,returned_usdg_principal_raw,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,'USDG_RESET_REPOSITION_V1',?,?,?,1000,1000)");
      insert.run("root","root",null,"child",0,"INITIAL_OPEN","WATCHING",null);
      insert.run("child","root","root",null,1,"USDG_RESET_REPOSITION","OPEN_PENDING","123");
      expect(()=>insert.run("other","root","child",null,1,"USDG_RESET_REPOSITION","OPEN_PENDING","1")).toThrow();
      expect(()=>db.prepare("INSERT INTO v4_bid_ladder_usdg_reset_v1(ladder_id,root_ladder_id,generation,policy,creation_reason,phase,created_at_ms,updated_at_ms) VALUES('missing','missing',0,'USDG_RESET_REPOSITION_V1','INITIAL_OPEN','WATCHING',1,1)").run()).toThrow();
      expect(()=>db.prepare("UPDATE v4_bid_ladder_usdg_reset_v1 SET returned_target_fee_raw='-1' WHERE ladder_id='root'").run()).toThrow();
      expect(()=>db.prepare("UPDATE v4_bid_ladder_usdg_reset_v1 SET returned_target_fee_raw='1.2' WHERE ladder_id='root'").run()).toThrow();
      expect(()=>db.prepare("UPDATE v4_bid_ladder_usdg_reset_v1 SET previous_ladder_id='other' WHERE ladder_id='root'").run()).toThrow();
      expect(db.pragma("foreign_key_check")).toEqual([]);
    }finally{db.close();}
  });

  it("creates generation zero atomically for new LIVE ladders and leaves dry runs disabled",()=>{
    const root=mkdtempSync(join(tmpdir(),"reset-056-repo-")),path=join(root,"ledger.sqlite");roots.push(root);migrateSqlite(path,"infra/migrations");const repo=new SqliteLedgerRepository(path);try{
      expect(repo.loadBidLadderUsdReset("none")).toBeUndefined();
      expect(()=>repo.transitionBidLadderUsdReset({ladderId:"none",from:"WATCHING",to:"BLOCKED",blockReason:"x"})).toThrow("V4_BID_LADDER_USDG_RESET_TRANSITION_CONFLICT");
    }finally{repo.close();}
  });
});
