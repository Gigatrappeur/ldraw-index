#!/usr/bin/env bun
// cli/get.ts — Récupérer les métadonnées ou générer un SVG d'une pièce

import { join } from 'node:path'
import parser from "yargs-parser";
import { displayPartMetadata } from "../lib/part";
import BrickIndex from "..";


function printHelp(): void {
	console.log(`
Usage: bun run cli/get.ts <ref> [options]

Options:
  --data <path>        Path vers dossier ou est extrait brick-index-data
  --format <type>      Format de sortie (json|human) (default: human)
  --color <id>         Couleur LDraw (default: 47)
  --output <path>      Fichier de sortie (default: <ref>.svg)
  --width <px>         Largeur SVG (default: 512)
  --azimuth <deg>      Azimut caméra (default: 30)
  --elevation <deg>    Élévation caméra (default: 15)
  --help               Afficher cette aide

Exemples:
  bun run cli/get.ts 3001                     # Métadonnées
  bun run cli/get.ts 3001 --format json       # Métadonnées en JSON prettifié
  bun run cli/get.ts 3001 --format svg        # SVG
  bun run cli/get.ts 3001 --format svg --color 15    # SVG couleur rouge
  bun run cli/get.ts 3001pb01                 # Métadonnées par element ID
  `);
}

interface ParsedArgs {
	_: string[];
	format: string;
	color: number;
	output: string;
	width: number;
	azimuth: number;
	elevation: number;
	help: boolean;
	h: boolean;
	data: string
}

export async function run(args: string[] = []): Promise<void> {
	const parsed = parser(args, {
		alias: { h: "help" },
		string: ["output", "format", "data"],
		number: ["color", "width", "azimuth", "elevation"],
		boolean: ["help", "h"],
		default: {
			color: 47,
			width: 512,
			azimuth: 30,
			elevation: 15,
			data: join(import.meta.dir, "..", "..", "data")
		},
	}) as ParsedArgs;

	if (parsed.help || parsed.h) {
		printHelp();
		return;
	}

	const ref = parsed._[0];
	if (!ref) {
		printHelp();
		return;
	}

	const colorCode = parsed.color;
	const width = parsed.width;
	const azimuth = parsed.azimuth;
	const elevation = parsed.elevation;

	const index = new BrickIndex({dataDir: parsed.data})

	if (['svg', 'glb', 'gltf'].includes(parsed.format)) {
		
		const outputPath = parsed.output || `${ref}.${parsed.format}`;

		if (parsed.format === 'svg') {
			console.log(`Génération SVG pour ${ref}...`);
			console.log(`  Couleur: ${colorCode}`);
			console.log(`  Sortie: ${outputPath}`);
			console.log(`  Taille: ${width}x${width}`);
			console.log(`  Camera: azimuth=${azimuth}°, elevation=${elevation}°\n`);
		} else {
			console.log(`Génération ${parsed.format.toLocaleUpperCase()} pour ${ref}...`);
			console.log(`  Couleur: ${colorCode}`);
			console.log(`  Sortie: ${outputPath}`);
		}
		let file: string | Uint8Array;
		if (parsed.format === 'svg' || parsed.format === 'gltf') {
			file = await index.generate(ref, parsed.format as "svg" | "gltf", { width, azimuth, elevation, color: colorCode });
		} else {
			file = await index.generate(ref, parsed.format as "glb", { color: colorCode });
		}

		await Bun.write(outputPath, file);
		console.log(`${parsed.format.toUpperCase()} généré: ${outputPath} (${(file.length / 1024).toFixed(1)} Ko)`);
	} else {
		const metadata = await index.get(ref);
		if (parsed.format === 'json') {
			console.log(JSON.stringify(metadata, null, 2));
		} else {
			// Format « human readable » (défaut) : affichage libellé.
			displayPartMetadata(metadata);
		}
	}
	index.close()

}

// Exécution directe (bun run cli/get.ts)
if (process.argv[1]?.replace(/\\/g, "/").endsWith("/get.ts")) {
	run(process.argv.slice(2)).catch((err) => {
		console.error("Erreur:", err);
		process.exit(1);
	});
}
