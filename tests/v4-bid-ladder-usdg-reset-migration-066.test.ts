import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateSqlite } from "@funi/ledger";

const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));

describe("migration 066 Reposition single-flight lease",()=>{
  it("adds only the bounded lease authority and remains migration-idempotent",()=>{
    const root=mkdtempSync(join(tmpdir(),"reposition-lease-migration-")),path=join(root,"ledger.sqlite");roots.push(root);
    const first=migrateSqlite(path,"infra/migrations"),second=migrateSqlite(path,"infra/migrations"),db=new Database(path,{readonly:true});
    try{
      expect(first.applied).toContain("066_reposition_single_flight_lease.sql");
      expect(second.applied).toEqual(first.applied);
      expect(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE migration_path='066_reposition_single_flight_lease.sql'").get()).toEqual({count:1});
      expect(db.pragma("table_info(v4_bid_ladder_usdg_reset_execution_leases)")).toEqual(expect.arrayContaining([
        expect.objectContaining({name:"ladder_id",pk:1}),
        expect.objectContaining({name:"owner_id",notnull:1}),
        expect.objectContaining({name:"lease_until_ms",notnull:1}),
      ]));
      expect(readFileSync("infra/migrations/066_reposition_single_flight_lease.sql","utf8")).not.toMatch(/SIGN|BROADCAST|transaction_hash/i);
    }finally{db.close();}
  });
});
