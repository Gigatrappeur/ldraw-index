import { describe, it, expect, afterEach } from "bun:test";
import { createTestDb } from "../helpers";
import { DB } from "../../src/lib/db";

describe("DB", () => {
  let db: DB;

  afterEach(() => {
    if (db && db.internalDb) {
      db.internalDb.close();
    }
  });

  it("opens a database", () => {
    const testDb = createTestDb();
    db = new DB(testDb);
    const result = db.internalDb.query("SELECT 1 as num").get() as any;
    expect(result.num).toBe(1);
  });

  it("accepts an in-memory database for testing", () => {
    const testDb = createTestDb();
    db = new DB(testDb);
    db.internalDb.run("CREATE TABLE test (id INTEGER)");
    db.internalDb.run("INSERT INTO test VALUES (1)");

    const result = db.internalDb.query("SELECT * FROM test").all() as any;
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });
});

describe("DB schema", () => {
  let db: DB;

  afterEach(() => {
    if (db && db.internalDb) {
      db.internalDb.close();
    }
  });

  it("loads the SQLite schema", () => {
    db = new DB(createTestDb());

    const tables = db.internalDb.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;

    const tableNames = tables.map(t => t.name).sort();
    expect(tableNames).toContain("parts");
  });

  it("allows insertion into parts", () => {
    db = new DB(createTestDb());
    db.internalDb.run(`INSERT INTO parts (ldraw_ref, name, category, keywords, tag)
            VALUES ('3001', 'Brick 2x4', 'Bricks', NULL, NULL)`);

    const result = db.internalDb.query("SELECT * FROM parts WHERE ldraw_ref = '3001'").all() as any;
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Brick 2x4");
  });
});
