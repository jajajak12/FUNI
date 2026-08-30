import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";

const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));

describe("SQLite foreground connection admission",()=>{
  it("opens an already-WAL runtime repository without waiting behind an active writer",async()=>{
    const root=mkdtempSync(join(tmpdir(),"funi-runtime-open-")),path=join(root,"db.sqlite");roots.push(root);migrateSqlite(path,"infra/migrations");
    const child=spawn(process.execPath,["-e",`const Database=require('better-sqlite3'),db=new Database(${JSON.stringify(path)});db.pragma('journal_mode=WAL');db.exec('BEGIN IMMEDIATE');process.stdout.write('locked');setTimeout(()=>{db.exec('COMMIT');db.close()},500)`],{cwd:process.cwd(),stdio:["ignore","pipe","inherit"]}),closed=new Promise<void>((resolve,reject)=>{child.once("close",()=>resolve());child.once("error",reject);});
    await new Promise<void>((resolve,reject)=>{child.stdout!.on("data",chunk=>{if(String(chunk).includes("locked"))resolve();});child.once("error",reject);});
    const started=Date.now(),repo=new SqliteLedgerRepository(path,{busyTimeoutMs:50}),elapsedMs=Date.now()-started;
    try{expect(String(repo.db.pragma("journal_mode",{simple:true})).toLowerCase()).toBe("wal");expect(elapsedMs).toBeLessThan(150);}finally{repo.close();await closed;}
    const samples:number[]=[];
    for(let index=0;index<50;index++){
      const sampleStarted=performance.now(),sample=new SqliteLedgerRepository(path,{busyTimeoutMs:50});
      sample.close();samples.push(performance.now()-sampleStarted);
    }
    samples.sort((a,b)=>a-b);
    const percentile=(value:number)=>samples[Math.min(samples.length-1,Math.ceil(samples.length*value)-1)]!;
    console.log(JSON.stringify({event:"public_db_open_performance",samples:samples.length,p50Ms:percentile(.5),p95Ms:percentile(.95),maxMs:samples.at(-1)}));
    expect(percentile(.95)).toBeLessThan(150);
  });
});
