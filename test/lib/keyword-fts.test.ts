import { describe, it, expect, afterEach } from "bun:test";
import { createTestDb, insertTestParts, fillFts } from "../helpers";
import { DB } from "../../src/lib/db";

// Vérifie que la normalisation côté recherche fait trouver une pièce indexée
// sous sa forme canonique (« 2x2 ») quel que soit la forme tapée à la recherche.
describe("normalisation des dimensions dans la recherche FTS", () => {
	let db: DB;
	afterEach(() => {
		if (db && db.internalDb) db.internalDb.close();
	});

	function setup(keywords: string): DB {
		const testDb = createTestDb();
		insertTestParts(testDb, [
			{ ldrawRef: "3001", name: "Plate Round 2x2", category: "Plates", keywords },
		]);
		fillFts(testDb);
		return new DB(testDb);
	}

	it("recherche « 2 x  2 » (espaces) retrouve une pièce indexée « 2x2 »", () => {
		db = setup("plate 2x2 round");
		expect(db.searchDistinct("2 x  2", {}, 50, 0).map(r => r.ldrawRef)).toContain("3001");
		expect(db.countDistinctFts("2 x  2", {})).toBe(1);
	});

	it("recherche « 2×2 » (signe ×) retrouve aussi la pièce", () => {
		db = setup("plate 2x2 round");
		expect(db.searchDistinct("2×2", {}, 50, 0).map(r => r.ldrawRef)).toContain("3001");
	});

	it("recherche « 2 x 2 x 2 » retrouve une pièce indexée « 2x2x2 »", () => {
		db = setup("brick 2x2x2");
		expect(db.searchDistinct("2 x 2 x 2", {}, 50, 0).map(r => r.ldrawRef)).toContain("3001");
	});

	it("ne retrouve rien pour une dimension absente", () => {
		db = setup("plate 2x2 round");
		expect(db.searchDistinct("4 x 8", {}, 50, 0).map(r => r.ldrawRef)).not.toContain("3001");
		expect(db.countDistinctFts("4 x 8", {})).toBe(0);
	});
});
