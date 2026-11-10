import { Database } from "bun:sqlite";

const PARTS_TABLE = `
CREATE TABLE IF NOT EXISTS parts (
  ldraw_ref TEXT    PRIMARY KEY,
  name      TEXT    NOT NULL,
  category  TEXT    NOT NULL,
  keywords  TEXT,
  tag       TEXT
);
CREATE INDEX IF NOT EXISTS idx_category ON parts(category);
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
CREATE INDEX IF NOT EXISTS idx_variants_part ON part_variants(ldraw_ref);
CREATE INDEX IF NOT EXISTS idx_variants_lego ON part_variants(lego_ref);
`;

export interface TestPart {
	ldrawRef: string;
	name: string;
	category: string;
	keywords?: string;
	tag?: string;
	variants?: Array<{ legoRef: string; color: number }>;
}

export function createTestDb(): Database {
	const db = new Database(":memory:");
	db.exec(PARTS_TABLE);
	db.exec(VARIANTS_TABLE);
	return db;
}

/**
 * Insère des pièces canoniques et leurs variants (couleurs / refs LEGO).
 */
export function insertTestParts(db: Database, parts: TestPart[]): void {
	db.run("BEGIN");
	for (const part of parts) {
		const variantRows = part.variants ?? [];

		// Pièce canonique.
		const partStmt = db.prepare(`
			INSERT INTO parts (ldraw_ref, name, category, keywords, tag)
			VALUES ($ldrawRef, $name, $category, $keywords, $tag)
		`);
		partStmt.run({
			$ldrawRef: part.ldrawRef,
			$name: part.name,
			$category: part.category,
			$keywords: part.keywords ?? null,
			$tag: part.tag ?? null,
		});

		// Variants (couleurs / refs LEGO).
		for (const v of variantRows) {
			db.prepare(`
				INSERT INTO part_variants (ldraw_ref, lego_ref, color)
				VALUES ($ldrawRef, $legoRef, $color)
			`).run({
				$ldrawRef: part.ldrawRef,
				$legoRef: v.legoRef,
				$color: v.color,
			});
		}
	}
	db.run("COMMIT");
}

/**
 * Remplit l'index FTS à partir de parts + part_variants.
 * 6 colonnes sémantiques ; seules les 5 disponibles sont remplies (ldraw_ref,
 * name, category, keywords, lego_refs), les colonnes « source_* » restent vides.
 */
export function fillFts(db: Database): void {
	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts USING fts5(
			ldraw_ref,
			name,
			category,
			keywords,
			lego_refs,
			source_refs,
			tokenize='unicode61 remove_diacritics 1'
		);
	`);
	db.exec(`
		INSERT INTO parts_fts (ldraw_ref, name, category, keywords, lego_refs)
		SELECT p.ldraw_ref, p.name, p.category, p.keywords, pv.legoRefs
		FROM parts p
		LEFT JOIN (
			SELECT ldraw_ref, GROUP_CONCAT(lego_ref, ' ') AS legoRefs
			FROM part_variants
			WHERE lego_ref IS NOT NULL
			GROUP BY ldraw_ref
		) pv ON pv.ldraw_ref = p.ldraw_ref;
	`);
}
