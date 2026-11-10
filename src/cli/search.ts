#!/usr/bin/env bun
// cli/search.ts — Recherche de pièces (FTS5 + filtres)

import { join } from 'node:path'
import parser from "yargs-parser";
import BrickIndex, { type SearchResult } from "..";

function printHelp(): void {
	console.log(`
Usage: bun run cli/search.ts [query] [options]

Options:
  --data <path>        Path vers dossier ou est extrait brick-index-data
  --format <type>      Format de sortie (json|human) (default: human)

Exemples:
  bun run cli/search.ts "brick 2x4"
  bun run cli/search.ts "brick 2x4" --format json
  bun run cli/search.ts "racing" --category "Technic" --color 15
  bun run cli/search.ts --ldraw 3001
  bun run cli/search.ts --rebrickable 3001
  bun run cli/search.ts --lego 3001pb01
  bun run cli/search.ts "wheel" --no-stickers
  `);
}



type SearchOptions = {
	query?: string;
	lego?: string;
	rebrickable?: string;
	ldraw?: string;
	category?: string;
	color?: number;
	exclude_stickers?: boolean;
	help?: boolean;
	format?: string;
	data: string
};

export async function run(args: string[] = []): Promise<void> {
	const parsed = parser(args, {
		alias: { h: "help" },
		string: ["ldraw", "rebrickable", "lego", "category", "color", "data", "format"],
		boolean: ["help", "h", "no-stickers"],
		default: {
			data: join(import.meta.dir, "..", "..", "data")
		}
	});

	if (parsed['help'] || parsed['h']) {
		printHelp();
		return;
	}

	const options: SearchOptions = {
		query: parsed._.join(' ') as string | undefined,
		category: parsed['category'],
		color: parsed['color'] ? (parsed['color'] as number) : undefined,
		exclude_stickers: (parsed['no-stickers'] as boolean) || undefined,
		format: parsed['format'],
		data: parsed['data']
	};

	const brickIndex = new BrickIndex({ dataDir: options.data })

	// const colorTable = ldrawParser.colorTable;

	let results: SearchResult;
	let mode = "";
	let query = ''

	if (options.query) {
		mode = `Search FTS`;
		query = options.query
		results = await brickIndex.search({
			q: options.query,
			category: options.category,
			color: options.color,
			excludeStickers: options.exclude_stickers,
		});
	} else {
		printHelp();
		brickIndex.close();
		return;
	}

	if (results.total === 0) {
		console.log(`Aucun résultat "${mode}" pour "${query}"`);
		brickIndex.close();
		return;
	}

	const format = options.format ?? 'human';

	if (format === 'json') {
		console.log(JSON.stringify({ total: results.total, items: results.items }, null, 2));
		brickIndex.close();
		return;
	}

	console.log(`\n${results.total} résultat(s) pour ${query}:\n`);
	console.log("LDraw   | Nom                                    | Tag               | Couleurs / Refs");
	console.log("--------|----------------------------------------|-------------------|-----------------");

	function variantCounts(variants: { color: number; legoRef: string }[]): string {
		const colors = new Set(variants.map(v => v.color));
		const legos = new Set(variants.map(v => v.legoRef));
		return `${colors.size} / ${legos.size}`;
	}

	for (const r of results.items) {
		const nameBase = r.name ?? "";
		const name = nameBase.length > 39 ? nameBase.slice(0, 36) + "..." : nameBase;
		const tagBase = r.tag ?? "";
		const tag = tagBase.length > 18 ? tagBase.slice(0, 17) + "..." : tagBase;
		console.log(`${r.ldrawRef.padEnd(8)}| ${name.padEnd(39)}| ${tag.padEnd(18)}| ${variantCounts(r.variants ?? [])}`);
	}
	brickIndex.close();
}

// Exécution directe (bun run cli/search.ts)
if (process.argv[1]?.replace(/\\/g, "/").endsWith("/search.ts")) {
	run(process.argv.slice(2)).catch((err) => {
		console.error("Erreur:", 'message' in err ? err.message : err);
		process.exit(1);
	});
}
