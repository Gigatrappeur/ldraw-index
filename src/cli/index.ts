#!/usr/bin/env bun
// cli/index.ts — CLI unifié pour brick-index

import { run as searchRun } from "./search";
import { run as getRun } from "./get";
import { run as getGeometryRun } from "./getGeometry";
import { runInit } from "./init";

const HELP = `
brick-index — catalogue de pièces LEGO/LDraw

Usage:
  brick-index <command> [options]

Commandes:
  init               Télécharger les données (SQLite + LDraw)
  search <query>     Recherche de pièces (FTS5 + filtres)
  get <ref>          Métadonnées d'une pièce ou génération SVG/GLB
  get:geometry <ref> Géométrie jsonifiable (meshs indexés + matériau)

Options:
  --help, -h         Afficher cette aide

Exemples:
  brick-index init --version v1.0.0
  brick-index search "brick 2x4" --category Bricks
  brick-index get 3001 --format svg --color 15
  brick-index get:geometry 3001 --unit mm
`;

type Subcommand = "init" | "search" | "get" | "get:geometry";

const COMMANDS: Record<Subcommand, (args: string[]) => Promise<void>> = {
	search: searchRun,
	get: getRun,
	"get:geometry": getGeometryRun,
	init: runInit,
};

function printHelp(): void {
	console.log(HELP);
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);

	if (!command || command === "help" || command === "-h" || command === "--help") {
		printHelp();
		process.exit(0);
	}

	const handler = COMMANDS[command as Subcommand];
	if (!handler) {
		console.error(`Commande inconnue: "${command}"`);
		console.error("Utilisez \"--help\" pour voir les commandes disponibles.");
		process.exit(1);
	}

	await handler(args);
}

main().catch((err) => {
	console.error("[cli] Erreur:", err);
	process.exit(1);
});
