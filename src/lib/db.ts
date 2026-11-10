import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeDimension } from "./keyword";


export type SearchMode = "ldraw" | "rebrickable" | "lego";

// Pièce canonique (UNE ligne par ldraw_ref).
// Couleurs / refs LEGO vivent dans part_variants, pas ici.
export interface PartRow {
	ldrawRef: string
	name: string
	category: string
	keywords: string | null
	tag: string | null
}

export interface ElementRow {
	legoRef: string;
	color: number;
}

export interface PartVariant {
	color: number;
	// Un variant = un élément LEGO : lego_ref et color sont toujours présents (NOT NULL).
	legoRef: string;
}

export interface DistinctPartRow extends PartRow {
	variants: PartVariant[];
}

export interface SearchFilters {
   category?: string;
   color?: number;
   excludeStickers?: boolean;
}

function buildFtsConditions(
	query: string,
	filters: SearchFilters = {},
): { sql: string; params: Record<string, unknown> } {
	const conditions: string[] = [];
	const params: Record<string, unknown> = {};

	// On normalise les dimensions de la requête (« 2 x  2 » -> « 2x2 ») afin de matcher
	// les jetons indexés de la même façon. Cf. normalizeDimension.
	const normalizedQuery = normalizeDimension(query);

	if (normalizedQuery) {
		conditions.push("parts_fts MATCH $query");
		params["$query"] = `${normalizedQuery ? '"' + normalizedQuery + '"' : ''}*`;
	}
	if (filters.category) {
		conditions.push("p.category = $category");
		params["$category"] = filters.category;
	}
	if (filters.color !== undefined && filters.color !== null) {
		// La couleur vit dans part_variants : on ne garde que les pièces
		// possedant au moins un variant de cette couleur.
		conditions.push("p.ldraw_ref IN (SELECT ldraw_ref FROM part_variants WHERE color = $color)");
		params["$color"] = filters.color;
	}
	if (filters.excludeStickers) {
		conditions.push("p.category != 'Stickers'");
	}

	return { sql: conditions.join(" AND "), params };
}

export class DB {

	private db: Database
	constructor(database: Database | string) {
		if (typeof(database) == 'string') {
			if (!existsSync(database)) {
				throw new Error(`[db] Base de données introuvable: ${database}\nIl faut lancer "bun run init --data ${dirname(database)}" pour télécharger les données`)
			}
			this.db = new Database(database, { readonly: true })
			console.error(`[db] Ouverture de la base de données: ${database} (readonly)`)
		} else {
			this.db = database
		}
	}

	get internalDb(): Database {
		return this.db;
	}

	// searchByRef(ref: string, mode: SearchMode, options?: { limit?: number; offset?: number }): PartRow[] {
	// 	let sql: string;
	// 	const params: { $ref: string; $limit?: number; $offset?: number } = { $ref: ref };

	// 	if (mode === "ldraw") {
	// 		sql = `
	// 		SELECT ldraw_ref AS ldrawRef, name, category, keywords, tag
	// 		FROM parts
	// 		WHERE ldraw_ref = $ref
	// 		ORDER BY ldraw_ref`;
	// 	} else if (mode === "lego") {
	// 		// lego_ref est stocké dans part_variants.
	// 		sql = `
	// 		SELECT p.ldraw_ref AS ldrawRef, p.name, p.category, p.keywords, p.tag
	// 		FROM parts p
	// 		JOIN part_variants pv ON pv.ldraw_ref = p.ldraw_ref
	// 		WHERE pv.lego_ref = $ref
	// 		ORDER BY p.ldraw_ref`;
	// 	} else {
	// 		// rebrickable : plus de colonne dans le nouveau schéma.
	// 		return [];
	// 	}

	// 	if (options?.limit != null) {
	// 		sql += " LIMIT $limit";
	// 		params.$limit = options.limit;
	// 	}
	// 	if (options?.offset != null) {
	// 		if (options.limit == null) sql += " LIMIT -1";
	// 		sql += " OFFSET $offset";
	// 		params.$offset = options.offset;
	// 	}
	// 	return this.db.prepare(sql).all(params) as PartRow[];
	// }

	// countByRef(ref: string, mode: SearchMode): number {
	// 	if (mode === "rebrickable") return 0;

	// 	let sql: string;
	// 	const params: { $ref: string } = { $ref: ref };

	// 	if (mode === "ldraw") {
	// 		sql = `SELECT COUNT(*) as count FROM parts WHERE ldraw_ref = $ref`;
	// 	} else {
	// 		sql = `
	// 		SELECT COUNT(*) as count
	// 		FROM parts p
	// 		JOIN part_variants pv ON pv.ldraw_ref = p.ldraw_ref
	// 		WHERE pv.lego_ref = $ref`;
	// 	}

	// 	const result = this.db.prepare(sql).get(params) as { count: number } | null;
	// 	return result?.count ?? 0;
	// }

	countDistinctFts(query: string, filters: SearchFilters = {}): number {
		// Une seule ligne FTS par pièce : COUNT(*) et COUNT(DISTINCT ldraw_ref)
		// sont équivalents ici, on garde DISTINCT pour la clarté sémantique.
		const { sql, params } = buildFtsConditions(query, filters);
		const whereClause = sql.length > 0 ? `WHERE ${sql}` : "";

		// TODO corriger le typage
		const result = this.db.prepare<{ count: number }, any>(`
		SELECT COUNT(DISTINCT p.ldraw_ref) as count
		FROM parts p
		JOIN parts_fts ON parts_fts.ldraw_ref = p.ldraw_ref
		${whereClause}
	  `).get({ ...params });

		return result?.count ?? 0;
	}

	searchDistinct(query: string, filters: SearchFilters = {}, limit: number = 50, offset: number = 0): DistinctPartRow[] {
		const { sql, params } = buildFtsConditions(query, filters);
		const whereClause = sql.length > 0 ? `WHERE ${sql}` : "";
		const orderBy = query ? "ORDER BY parts_fts.rank" : "ORDER BY p.ldraw_ref";

		// TODO corriger le typage
		// parts contient déjà UNE ligne par ldraw_ref : pas de GROUP BY nécessaire.
		const rows = this.db.prepare(`
		SELECT p.ldraw_ref AS ldrawRef, p.name, p.category, p.keywords, p.tag
		FROM parts p
		JOIN parts_fts ON parts_fts.ldraw_ref = p.ldraw_ref
		${whereClause}
		${orderBy}
		LIMIT $limit OFFSET $offset
	  `).all({ ...params, $limit: limit, $offset: offset } as never) as DistinctPartRow[];

		if (rows.length === 0) return rows;

		const byRef = this.getVariantsByRefs(rows.map(r => r.ldrawRef));
		for (const row of rows) {
			row.variants = byRef.get(row.ldrawRef) ?? [];
		}

		return rows;
	}

	getVariantsByRefs(refs: string[]): Map<string, PartVariant[]> {
		// Les variants (couleurs / refs LEGO) sont dans part_variants.
		const byRef = new Map<string, PartVariant[]>();
		if (refs.length === 0) return byRef;

		const variants = this.db.prepare<{ ldrawRef: string; color: number; legoRef: string }, string[]>(`
		SELECT ldraw_ref AS ldrawRef, color, lego_ref AS legoRef
		FROM part_variants
		WHERE ldraw_ref IN (${refs.map(() => "?").join(", ")})
		ORDER BY ldraw_ref, color
	  `).all(...refs);

		for (const v of variants) {
			const list = byRef.get(v.ldrawRef);
			if (list) list.push({ color: v.color, legoRef: v.legoRef });
			else byRef.set(v.ldrawRef, [{ color: v.color, legoRef: v.legoRef }]);
		}

		return byRef;
	}

	getByLdrawRef(ldrawRef: string): PartRow | undefined {
		// Recherche indexée par ref LDraw.
		const result = this.db.prepare<PartRow, [{$ref: string}]>(`
		SELECT ldraw_ref AS ldrawRef, name, category, keywords, tag
		FROM parts
		WHERE ldraw_ref = $ref
		LIMIT 1
	  `).get({ $ref: ldrawRef });
		return result ?? undefined;
	}

	getByLegoRef(legoRef: string): { ldrawRef: string, legoRef: string, color: number } | undefined {
		// Recherche indexée par ref LDraw.
		const result = this.db.prepare<{ ldrawRef: string, legoRef: string, color: number }, [{$ref: string}]>(`
		SELECT ldraw_ref AS ldrawRef, lego_ref as legoRef, color
		FROM part_variants
		WHERE lego_ref = $ref
		LIMIT 1
	  `).get({ $ref: legoRef });
		return result ?? undefined;
	}

	/** Liste toutes les references LDraw du catalogue (triées par ref). */
	getAllLdrawRefs(): string[] {
		return this.db.prepare<{ ldrawRef: string }, []>(`
		SELECT ldraw_ref AS ldrawRef
		FROM parts
		ORDER BY ldraw_ref
	  `).all().map(row => row.ldrawRef);
	}

   getElementVariants(ldrawRef: string): ElementRow[] {
     return this.db.prepare<ElementRow, [{$ref: string}]>(`
     SELECT lego_ref AS legoRef, color
     FROM part_variants
     WHERE ldraw_ref = $ref
     ORDER BY color
   `).all({ $ref: ldrawRef })
   }

   getCategories(): string[] {
     return this.db.prepare<{category: string}, []>(`
     SELECT DISTINCT category
     FROM parts
     WHERE category IS NOT NULL
     ORDER BY category
   `).all().map(item => item.category);
   }
}
