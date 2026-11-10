#!/usr/bin/env bun
// cli/report.ts — Rapport de taille du cache

import { readdir } from "node:fs/promises";
import { join } from "node:path";

// TODO ajouter dans le calcul, le dossier contenantl base et les fichiers ldraw
const cacheDirs = ["cache/glb", "cache/sprite"];
// , "data/ldraw" 

async function getTotalSize(dir: string): Promise<{ size: number; files: number }> {
	let totalSize = 0;
	let files = 0;

	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			const sub = await getTotalSize(fullPath);
			totalSize += sub.size;
			files += sub.files;
		} else if (entry.isFile()) {
			const stat = await Bun.file(fullPath).stat();
			totalSize += stat.size;
			files++;
		}
	}

	return { size: totalSize, files };
}

function formatReport(dir: string, sizeBytes: number, fileCount: number): string {
	return `${dir}: ${(sizeBytes / 1024 / 1024).toFixed(2)} Mo (${fileCount} fichiers)`;
}


export async function run(): Promise<void> {
	console.log("[report] Rapport de taille\n");

	let grandTotal = 0;

	for (const dir of cacheDirs) {
		let stat;
		try {
			stat = await Bun.file(dir).stat();
		} catch {
			console.log(`${dir}: [non existant]`);
			continue;
		}
		if (!stat.isDirectory) {
			console.log(`${dir}: [non existant]`);
			continue;
		}

		const { size: totalSize, files } = await getTotalSize(dir);
		grandTotal += totalSize;
		console.log(formatReport(dir, totalSize, files));
		console.log("");
	}

	// Taille de la base
	// const dbStat = await Bun.file(DB.PATH).stat();
	// grandTotal += dbStat.size;
	// console.log(`data/brick-data.sqlite:`);
	// console.log(`  Taille: ${(dbStat.size / 1024 / 1024).toFixed(2)} Mo`);
	// console.log("");

	console.log(`Total: ${(grandTotal / 1024 / 1024).toFixed(2)} Mo`);
}

// Exécution directe (bun run cli/report.ts)
if (process.argv[1]?.replace(/\\/g, "/").endsWith("/report.ts")) {
	run().catch((err) => {
		console.error("[report] Erreur:", err);
		process.exit(1);
	});
}
