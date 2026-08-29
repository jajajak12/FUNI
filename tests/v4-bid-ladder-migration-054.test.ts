import Database from "better-sqlite3";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateSqlite, sqliteStatus } from "@funi/ledger";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function insertLadder(db: Database.Database, id: string, status: string) {
  const at = 1_000;
  db.prepare(
    "INSERT INTO v4_bid_ladders(ladder_id,strategy_version,execution_mode,pool_id,currency0,currency1,fee,tick_spacing,hooks,funding_token,target_token,funding_index,target_index,reference_tick,reference_block,total_funding_amount_raw,entry_usd_snapshot,status,created_at_ms,updated_at_ms) VALUES(?,'V4_BID_LADDER_V1','LIVE',?,?,?,?,?,?,?,?,?,?,0,'1','1000000',1,?,?,?)",
  ).run(
    id,
    `0x${"1".repeat(64)}`,
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002",
    3000,
    10,
    "0x0000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000002",
    "0x0000000000000000000000000000000000000001",
    1,
    0,
    status,
    at,
    at,
  );
  const leg = db.prepare(
    "INSERT INTO v4_bid_ladder_legs(ladder_id,leg_index,upper_drop_bps,lower_drop_bps,capital_weight_bps,tick_lower,tick_upper,funding_amount_raw,planned_liquidity_raw,funding_index,target_index,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,1,0,?,?,?)",
  );
  for (let index = 0; index < 5; index++)
    leg.run(
      id,
      index,
      (index + 1) * 100,
      (index + 2) * 100,
      [800, 1200, 1800, 2500, 3700][index],
      index,
      index + 1,
      "200000",
      "1",
      status,
      at,
      at,
    );
}

describe("migration 054 BID Ladder CANCELLED lifecycle", () => {
  it("preserves legacy lifecycle rows, initializes metadata, and is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "ladder-054-")),
      before = join(root, "through-053"),
      path = join(root, "ledger.sqlite");
    roots.push(root);
    mkdirSync(before);
    for (const name of readdirSync("infra/migrations"))
      if (/^0\d\d_/.test(name) && Number(name.slice(0, 3)) <= 53)
        cpSync(join("infra/migrations", name), join(before, name));
    migrateSqlite(path, before);
    let db = new Database(path);
    insertLadder(db, "legacy-planned", "PLANNED");
    insertLadder(db, "legacy-open", "OPEN");
    insertLadder(db, "legacy-closed", "CLOSED");
    db.close();

    expect(sqliteStatus(path, "infra/migrations").pending).toEqual(
      readdirSync("infra/migrations")
        .filter(
          (name) => /^(\d{3})_/.test(name) && Number(name.slice(0, 3)) > 53,
        )
        .sort(),
    );
    migrateSqlite(path, "infra/migrations");
    expect(migrateSqlite(path, "infra/migrations").pending).toEqual([]);
    db = new Database(path);
    try {
      expect(
        db
          .prepare(
            "SELECT ladder_id,status,terminal_reason,terminal_at_ms,revision FROM v4_bid_ladders ORDER BY ladder_id",
          )
          .all(),
      ).toEqual([
        {
          ladder_id: "legacy-closed",
          status: "CLOSED",
          terminal_reason: null,
          terminal_at_ms: null,
          revision: 0,
        },
        {
          ladder_id: "legacy-open",
          status: "OPEN",
          terminal_reason: null,
          terminal_at_ms: null,
          revision: 0,
        },
        {
          ladder_id: "legacy-planned",
          status: "PLANNED",
          terminal_reason: null,
          terminal_at_ms: null,
          revision: 0,
        },
      ]);
      db.prepare(
        "UPDATE v4_bid_ladders SET status='CANCELLED',terminal_reason='AUTO_EXPIRED_PLANNED_30M',terminal_at_ms=1801000 WHERE ladder_id='legacy-planned'",
      ).run();
      db.prepare(
        "UPDATE v4_bid_ladder_legs SET status='CANCELLED' WHERE ladder_id='legacy-planned'",
      ).run();
      expect(
        db.prepare("SELECT status FROM v4_bid_ladders WHERE ladder_id='legacy-planned'").get(),
      ).toEqual({ status: "CANCELLED" });
      expect(() =>
        db.prepare("UPDATE v4_bid_ladders SET status='ABANDONED' WHERE ladder_id='legacy-open'").run(),
      ).toThrow();
      expect(db.pragma("quick_check", { simple: true })).toBe("ok");
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
