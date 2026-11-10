#!/usr/bin/env bun
// cli/getGeometry.ts — Récupérer la géométrie jsonifiable d'une pièce
// (meshs indexés par couleur + matériau), pour reconstruire un mesh côté front.
//
// Commande équivalente : `brick-index get:geometry <ref> [options]`.

import { join } from 'node:path'
import parser from "yargs-parser";
import BrickIndex from "..";
import type { GeometryLengthUnit } from "../lib/geometry";

function printHelp(): void {
	console.log(`
Usage: bun run cli/getGeometry.ts <ref> [options]

Récupère la géométrie triangulée d'une pièce, jsonifiable, groupée par couleur
et munie de son matériau (prêt à monter sur un BufferGeometry + matériau).

Commande équivalente : \`brick-index get:geometry <ref> [options]\`.

Options:
  --data <path>        Path vers dossier ou est extrait brick-index-data
  --out <path>         Fichier de sortie (defaut : stdout)
  --normals <mode>     "flat" (defaut) | "smooth" | "none" — normals de face / lissées / absentes
  --no-weld            Ne pas souder les sommets (soupe de triangles, indices séquentiels)
  --unit <unité>       Unité de sortie : ldu|mm|cm|m|in|studs (defaut : studs)
  --help               Afficher cette aide

Exemples:
  bun run cli/getGeometry.ts 3001                 # géométrie en JSON (weld + normals de face)
  bun run cli/getGeometry.ts 3001 --unit mm       # en millimètres
  bun run cli/getGeometry.ts 3001 --normals smooth # normals lissées (fente 60°)
  bun run cli/getGeometry.ts 3001 --normals none  # sans normals
  bun run cli/getGeometry.ts 3001 --no-weld       # sans weld (soupe de triangles)
  bun run cli/getGeometry.ts 3001 --out 3001.json # écrire dans un fichier
  `);
}

interface ParsedArgs {
	_: string[];
	unit: string;
	normals: string;
	weld: boolean;
	out: string;
	help: boolean;
	h: boolean;
	data: string;
}

export async function run(args: string[] = []): Promise<void> {
	const parsed = parser(args, {
		alias: { h: "help" },
		string: ["data", "out", "unit", "normals"],
		boolean: ["help", "h", "weld"],
		default: {
			unit: "studs",
			normals: "flat",
			weld: true,
			data: join(import.meta.dir, "..", "..", "data"),
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

	const unit = parsed.unit as GeometryLengthUnit;
	const validUnits: GeometryLengthUnit[] = ["ldu", "mm", "cm", "m", "in", "studs"];
	if (!validUnits.includes(unit)) {
		console.error(`Unité inconnue : "${unit}". Valeurs possibles : ${validUnits.join(", ")}`);
		process.exit(1);
	}

	const normals = parsed.normals === "none" ? false
		: parsed.normals === "smooth" ? "smooth"
		: "flat";
	const weld = parsed.weld;

	const index = new BrickIndex({ dataDir: parsed.data });
	try {
		console.error(`Génération de la géométrie pour ${ref}...`);
		console.error(`  Unité : ${unit}`);
		console.error(`  Normales : ${normals === false ? "aucune" : (normals === "smooth" ? "lissées (fente 60°)" : "de face (flat)")}`);
		console.error(`  Weld : ${weld ? "activé" : "désactivé (soupe de triangles)"}`);

		const geometry = await index.getGeometry(ref, { unit, normals, weld: weld ? {} : false });

		const json = JSON.stringify(geometry, null, 2);
		if (parsed.out) {
			await Bun.write(parsed.out, json);
			console.error(`Géométrie générée : ${parsed.out} (${(json.length / 1024).toFixed(1)} Ko)`);
		} else {
			console.log(json);
		}
	} finally {
		index.close();
	}
}

// Exécution directe (bun run cli/getGeometry.ts)
if (process.argv[1]?.replace(/\\/g, "/").endsWith("/getGeometry.ts")) {
	run(process.argv.slice(2)).catch((err) => {
		console.error("Erreur:", err);
		process.exit(1);
	});
}
