import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { DB } from "../../src/lib/db";
import { buildPartMetadata } from "../../src/lib/part";

const PARTS_TABLE = `
CREATE TABLE IF NOT EXISTS parts (
  ldraw_ref TEXT    PRIMARY KEY,
  name      TEXT    NOT NULL,
  category  TEXT    NOT NULL,
  keywords  TEXT,
  tag       TEXT
);
`;

const VARIANTS_TABLE = `
CREATE TABLE IF NOT EXISTS part_variants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ldraw_ref  TEXT    NOT NULL,
  lego_ref   TEXT    NOT NULL,
  color      INTEGER NOT NULL,
  UNIQUE (ldraw_ref, lego_ref, color),
  FOREIGN KEY (ldraw_ref) REFERENCES parts(ldraw_ref)
);
`;

function createTestDb(): DB {
  const internalDb = new Database(":memory:");
  internalDb.exec(PARTS_TABLE);
  internalDb.exec(VARIANTS_TABLE);

  const db = Object.create(DB.prototype) as DB;
  Object.defineProperty(db, "db", { value: internalDb, writable: true });
  return db;
}

function createMockColorTable() {
  const colors = new Map<number, {
    code: number;
    name: string;
    rgba: [number, number, number, number];
  }>();

  colors.set(15, { code: 15, name: "Red", rgba: [1, 0, 0, 1] });
  colors.set(1, { code: 1, name: "Dark Red", rgba: [0.5, 0, 0, 1] });
  colors.set(255, { code: 255, name: "White", rgba: [1, 1, 1, 1] });

  return {
    async get(code: number) {
      const c = colors.get(code);
      if (!c) throw new Error(`Color not found: ${code}`);
      return { ...c, value: 0, edge: 0, alpha: 255, luminance: 0, finish: "NORMAL" as const, isTransparent: false, hex: "000000" };
    },
    async getTable() {
      return colors;
    },
  };
}

function insertPart(db: DB, ldrawRef: string, name: string, category: string, variants: Array<{ legoRef: string; color: number }>) {
  db.internalDb.run("BEGIN");
  db.internalDb.prepare(
    `INSERT INTO parts (ldraw_ref, name, category, keywords, tag) VALUES ($ref, $name, $category, NULL, NULL)`
  ).run({ $ref: ldrawRef, $name: name, $category: category });
  for (const v of variants) {
    db.internalDb.prepare(
      `INSERT INTO part_variants (ldraw_ref, lego_ref, color) VALUES ($ref, $lego, $color)`
    ).run({ $ref: ldrawRef, $lego: v.legoRef, $color: v.color });
  }
  db.internalDb.run("COMMIT");
}

describe("buildPartMetadata", () => {
  let db: DB;
  let colorTable: ReturnType<typeof createMockColorTable>;

  beforeAll(() => {
    db = createTestDb();
    colorTable = createMockColorTable();
  });

  afterAll(() => {
    db.internalDb.close();
  });

  it("builds metadata for a part", async () => {
    insertPart(db, "3001", "Brick 2x4", "Bricks", [
      { legoRef: "6385794", color: 15 },
      { legoRef: "6385700", color: 1 },
      { legoRef: "6385799", color: 255 },
    ]);

    const part = { ldrawRef: "3001", name: "Brick 2x4", category: "Bricks", keywords: null, tag: null } as any;
    const metadata = await buildPartMetadata(db, part, colorTable);

    expect(metadata.ldrawRef).toBe("3001");
    expect(metadata.name).toBe("Brick 2x4");
    expect(metadata.colorCount).toBe(3);
    expect(metadata.elementCount).toBe(3);
    expect(metadata.variants).toHaveLength(3);
  });

  it("groups lego refs by color", async () => {
    insertPart(db, "3010", "Brick 2x4 Red", "Bricks", [
      { legoRef: "6385794", color: 15 },
      { legoRef: "6385700", color: 15 },
    ]);

    const part = { ldrawRef: "3010", name: "Brick 2x4 Red", category: "Bricks", keywords: null, tag: null } as any;
    const metadata = await buildPartMetadata(db, part, colorTable);

    const redVariant = metadata.variants.find(v => v.color === 15);
    expect(redVariant).toBeDefined();
    expect(redVariant!.colorName).toBe("Red");
    expect(redVariant!.legoRefs).toContain("6385794");
    expect(redVariant!.legoRefs).toContain("6385700");
  });

  it("handles a single-color part", async () => {
    insertPart(db, "3020", "Brick 2x6", "Bricks", [
      { legoRef: "6385800", color: 15 },
    ]);

    const part = { ldrawRef: "3020", name: "Brick 2x6", category: "Bricks", keywords: null, tag: null } as any;
    const metadata = await buildPartMetadata(db, part, colorTable);

    expect(metadata.colorCount).toBe(1);
    expect(metadata.elementCount).toBe(1);
  });
});

describe("buildPartMetadata — bounding box", () => {
  let db: DB;

  beforeAll(() => {
    db = createTestDb();
  });

  afterAll(() => {
    db.internalDb.close();
  });

  const mockColorTable = {
    async get() { return { name: 'Red', rgba: [1, 0, 0, 1] as [number, number, number, number] }; },
    async getTable() { return new Map(); },
  };

  it("dérive la bounding box depuis la géométrie du parser", async () => {
    insertPart(db, "3001", "Brick 2x4", "Bricks", [{ legoRef: "6385794", color: 15 }]);
    const part = { ldrawRef: "3001", name: "Brick 2x4", category: "Bricks", keywords: null, tag: null } as any;

    const mockParser = {
      async parse(name: string) {
        expect(name).toBe("3001.dat");
        return {
          geometry: {
            aabb: {
              min: { x: -40, y: -4, z: -20 },
              max: { x: 40, y: 24, z: 20 },
              center: { x: 0, y: 10, z: 0 },
              size: { x: 80, y: 28, z: 40 },
            },
          },
        };
      },
    };

    const metadata = await buildPartMetadata(db, part, mockColorTable, mockParser);

    expect(metadata.boundingBox).toEqual({
      min: [-40, -4, -20],
      max: [40, 24, 20],
      size: [80, 28, 40],
      center: [0, 10, 0],
    });
  });

  it("met boundingBox à null quand le parse échoue", async () => {
    insertPart(db, "9999", "Pièce fantôme", "Bricks", [{ legoRef: "6385999", color: 15 }]);
    const part = { ldrawRef: "9999", name: "Pièce fantôme", category: "Bricks", keywords: null, tag: null } as any;

    const mockParser = {
      async parse() { throw new Error("Part file not found"); },
    };

    const metadata = await buildPartMetadata(db, part, mockColorTable, mockParser);
    expect(metadata.boundingBox).toBeNull();
  });

  it("met boundingBox à null sans parser", async () => {
    insertPart(db, "3040", "Plate 2x4", "Bricks", [{ legoRef: "6385794", color: 15 }]);
    const part = { ldrawRef: "3040", name: "Plate 2x4", category: "Bricks", keywords: null, tag: null } as any;

    const metadata = await buildPartMetadata(db, part, mockColorTable);
    expect(metadata.boundingBox).toBeNull();
  });
});
