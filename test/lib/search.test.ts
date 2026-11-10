import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, insertTestParts, fillFts, type TestPart } from "../helpers";
import { DB } from "../../src/lib/db";



describe("getByLdrawRef", () => {
  let db: DB;

  beforeEach(() => {
    db = new DB(createTestDb());
    insertTestParts(db.internalDb, [
      { ldrawRef: "3001", name: "Brick 2x4", category: "Bricks", variants: [
        { legoRef: "6385794", color: 15 },
      ]},
    ] satisfies TestPart[]);
  });

  afterEach(() => {
    db.internalDb.close();
  });

  it("getByLdrawRef resout la pièce canonique (recherche indexée)", () => {
    const part = db.getByLdrawRef("3001");
    expect(part).toBeDefined();
    expect(part!.ldrawRef).toBe("3001");
  });

  it("retourne undefined si inconnu", () => {
    expect(db.getByLdrawRef("9999")).toBeUndefined();
  });
});

describe("getElementVariants", () => {
  let db: DB;

  beforeEach(() => {
    db = new DB(createTestDb());
    insertTestParts(db.internalDb, [
      { ldrawRef: "3001", name: "Brick 2x4", category: "Bricks", variants: [
        { legoRef: "6385794", color: 15 },
        { legoRef: "6385700", color: 1 },
        { legoRef: "6385799", color: 255 },
      ]},
      { ldrawRef: "3002", name: "Brick 2x6", category: "Bricks", variants: [
        { legoRef: "6385800", color: 15 },
      ]},
    ] satisfies TestPart[]);
  });

  afterEach(() => {
    db.internalDb.close();
  });

  it("returns variants for a part", () => {
    const variants = db.getElementVariants("3001");
    expect(variants).toHaveLength(3);
  });

  it("returns variants for another part", () => {
    const variants = db.getElementVariants("3002");
    expect(variants).toHaveLength(1);
  });

  it("returns empty array when part does not exist", () => {
    const variants = db.getElementVariants("9999");
    expect(variants).toHaveLength(0);
  });
});

describe("searchDistinct", () => {
  let db: DB;

  beforeEach(() => {
    db = new DB(createTestDb());
    insertTestParts(db.internalDb, [
      { ldrawRef: "3001", name: "Brick 2x4", category: "Bricks", keywords: "cube", variants: [
        { legoRef: "6385794", color: 15 },
        { legoRef: "6385800", color: 1 },
      ]},
      { ldrawRef: "3002", name: "Brick 2x6", category: "Bricks", keywords: "cube", variants: [
        { legoRef: "6385795", color: 15 },
      ]},
      { ldrawRef: "4001", name: "Tile Round", category: "Tiles", keywords: "plaque", variants: [
        { legoRef: "6385801", color: 15 },
      ]},
      { ldrawRef: "5001", name: "Sticker X", category: "Stickers", keywords: "autocollant", variants: [] },
    ] satisfies TestPart[]);
    fillFts(db.internalDb);
  });

  afterEach(() => {
    db.internalDb.close();
  });

  it("returns one row per unique ref_ldraw", () => {
    const results = db.searchDistinct("", { category: "Bricks" }, 50, 0);
    expect(results.map(r => r.ldrawRef).sort()).toEqual(["3001", "3002"]);
  });

  it("lists every color and lego ref of a piece in variants", () => {
    const results = db.searchDistinct("", { category: "Bricks" }, 50, 0);
    const p3001 = results.find(r => r.ldrawRef === "3001")!;
    expect(p3001.variants).toHaveLength(2);
    expect(p3001.variants.map(v => v.color).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 15]);
    expect(
      p3001.variants
        .map(v => v.legoRef)
        .filter((r): r is string => r != null)
        .sort(),
    ).toEqual(["6385794", "6385800"].sort());
  });

  it("returns a single variant for a piece with one variant", () => {
    const results = db.searchDistinct("", { category: "Bricks" }, 50, 0);
    const p3002 = results.find(r => r.ldrawRef === "3002")!;
    expect(p3002.variants).toHaveLength(1);
  });

  it("respects the category filter", () => {
    const results = db.searchDistinct("", { category: "Tiles" }, 50, 0);
    expect(results).toHaveLength(1);
    expect(results[0]!.ldrawRef).toBe("4001");
  });

  it("filters by variant color (present in partVariants)", () => {
    // Seule la pièce 3001 possède un variant de couleur 1 dans la catégorie Bricks.
    const results = db.searchDistinct("", { category: "Bricks", color: 1 }, 50, 0);
    expect(results.map(r => r.ldrawRef)).toEqual(["3001"]);
  });

  it("matches on the FTS query", () => {
    const results = db.searchDistinct("brick", {}, 50, 0);
    expect(results.some(r => r.ldrawRef === "3001")).toBe(true);
    expect(results.some(r => r.ldrawRef === "4001")).toBe(false);
  });

  it("applies limit and offset", () => {
    expect(db.searchDistinct("", { category: "Bricks" }, 1, 0)).toHaveLength(1);
    expect(db.searchDistinct("", { category: "Bricks" }, 1, 1)).toHaveLength(1);
  });

  it("counts distinct refs for pagination", () => {
    expect(db.countDistinctFts("", { category: "Bricks" })).toBe(2);
    expect(db.countDistinctFts("", { category: "Tiles" })).toBe(1);
    expect(db.countDistinctFts("brick", {})).toBe(2);
    expect(db.countDistinctFts("nonexistent", {})).toBe(0);
  });

  it("returns an empty array when nothing matches", () => {
    expect(db.searchDistinct("nonexistent", {}, 50, 0)).toEqual([]);
    expect(db.searchDistinct("", { category: "NonExistent" }, 50, 0)).toEqual([]);
  });
});
