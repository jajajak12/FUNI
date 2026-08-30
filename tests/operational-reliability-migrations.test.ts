import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateSqlite, sqliteStatus, SqliteLedgerRepository } from "@funi/ledger";

const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
const root=()=>{const value=mkdtempSync(join(tmpdir(),"funi-release-migrations-"));roots.push(value);return value;};

describe("operational reliability migration sequence",()=>{
  it("has unique ordered prefixes and replays a fresh database twice",()=>{
    const files=readdirSync("infra/migrations").filter(file=>file.endsWith(".sql")).sort(),prefixes=files.map(file=>file.slice(0,3));
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(files.at(-2)).toBe("069_v4_reposition_jit_attempt_budget.sql");
    expect(files.at(-1)).toBe("070_v4_registry_writer_amplification.sql");
    const path=join(root(),"fresh.sqlite"),first=migrateSqlite(path,"infra/migrations"),second=migrateSqlite(path,"infra/migrations"),status=sqliteStatus(path,"infra/migrations"),repo=new SqliteLedgerRepository(path);
    try{expect(first.applied).toContain("070_v4_registry_writer_amplification.sql");expect(second.applied).toEqual(first.applied);expect(second.pending).toEqual([]);expect(status.pending).toEqual([]);expect(repo.db.pragma("foreign_key_check")).toEqual([]);expect(repo.db.prepare("PRAGMA table_info('v4_bid_ladder_usdg_reset_v1')").all()).toEqual(expect.arrayContaining([expect.objectContaining({name:"jit_rematerialization_attempts"})]));}finally{repo.close();}
  });

  it("upgrades a current-release migration-068 database without editing applied checksums",()=>{
    const dir=root(),oldMigrations=join(dir,"migrations-068"),path=join(dir,"upgrade.sqlite");mkdirSync(oldMigrations);
    const oldFiles=readdirSync("infra/migrations").filter(file=>file.endsWith(".sql")&&Number(file.slice(0,3))<=68);
    for(const file of oldFiles)copyFileSync(join("infra/migrations",file),join(oldMigrations,file));
    migrateSqlite(path,oldMigrations);const before=new SqliteLedgerRepository(path),checksums=before.db.prepare("SELECT name,checksum FROM schema_migrations ORDER BY name").all();before.close();
    const upgrade=migrateSqlite(path,"infra/migrations"),repeat=migrateSqlite(path,"infra/migrations"),after=new SqliteLedgerRepository(path);
    try{expect(upgrade.applied.slice(-2)).toEqual(["069_v4_reposition_jit_attempt_budget.sql","070_v4_registry_writer_amplification.sql"]);expect(repeat.applied).toEqual(upgrade.applied);expect(repeat.pending).toEqual([]);expect(after.db.prepare("SELECT name,checksum FROM schema_migrations WHERE CAST(substr(name,1,3) AS INTEGER)<=68 ORDER BY name").all()).toEqual(checksums);expect(after.db.pragma("foreign_key_check")).toEqual([]);}finally{after.close();}
  });
});
