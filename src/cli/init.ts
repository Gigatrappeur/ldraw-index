#!/usr/bin/env bun
// cli/init.ts — Télécharger et extraire les données brick-index-data

import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import AdmZip from "adm-zip";
import parser from "yargs-parser";

function printHelp(): void {
	console.log(`
Usage: bun run cli/init.ts [options]

Options:
  --data <path>        Dossier de destination (default: data/)
  --url <url>          URL directe de l'archive à télécharger
  --version <tag>      Tag GitHub release (default: latest)
   --repo <owner/repo>  Dépôt GitHub (default: Gigatrappeur/ldraw-index)
  --force              Forcer le téléchargement même si les données existent
  --help               Afficher cette aide

Exemples:
  bun run cli/init.ts
  bun run cli/init.ts --version v1.0.0
  bun run cli/init.ts --url https://github.com/Gigatrappeur/ldraw-index/releases/download/v1.0.0/data.zip
  bun run cli/init.ts --data /tmp/ldraw-data --force
  `);
}

async function downloadFile(url: string, destPath: string): Promise<number> {
	console.log(`[init] Téléchargement depuis ${url}...`);

	const response = await fetch(url);
	if (!response.ok || !response.body) {
		throw new Error(`Échec du téléchargement (HTTP ${response.status})`);
	}

	const totalBytes = Number(response.headers.get("content-length") ?? 0);
	let received = 0;
	let lastPercent = -1;

	const file = Bun.file(destPath).writer();
	const reader = response.body.getReader();

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		file.write(value);
		received += value.byteLength;
		if (totalBytes > 0) {
			const percent = Math.floor((received / totalBytes) * 100);
			if (percent !== lastPercent && percent % 10 === 0) {
				console.log(`[init]   ${percent}% (${(received / 1024 / 1024).toFixed(0)} Mo)`);
				lastPercent = percent;
			}
		}
	}
	await file.end();
	console.log(`[init] Téléchargement terminé (${(received / 1024 / 1024).toFixed(1)} Mo)`);
	return received;
}

async function getLatestReleaseTag(repo: string): Promise<string> {
	console.log(`[init] Recherche dernière release de ${repo}...`);
	const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
	if (!response.ok) {
		throw new Error(`Impossible de récupérer la dernière release: HTTP ${response.status}`);
	}
	const data = (await response.json()) as { tag_name: string };
	return data.tag_name;
}

async function extractZip(archivePath: string, destDir: string): Promise<void> {
	const zip = new AdmZip(archivePath);
	zip.extractAllTo(destDir, true);
}

export async function runInit(args: string[] = []): Promise<void> {
	const parsed = parser(args, {
		alias: { h: "help" },
		string: ["data", "url", "version", "repo"],
		boolean: ["help", "h", "force"],
		default: {
			data: join(process.cwd(), "data"),
			repo: "Gigatrappeur/ldraw-index",
		},
	}) as Record<string, unknown>;

	if ((parsed['help'] as boolean) || (parsed['h'] as boolean)) {
		printHelp();
		return;
	}

	const dataDir = parsed['data'] as string;
	const explicitUrl = parsed['url'] as string | undefined;
	const version = parsed['version'] as string | undefined;
	const repo = parsed['repo'] as string;
	const force = parsed['force'] as boolean;

	// Vérifier si les données existent déjà
	const sqlitePath = join(dataDir, "ldraw-data.sqlite");
	if (!force && existsSync(sqlitePath)) {
		console.log(`[init] Les données existent déjà dans ${dataDir}`);
		console.log(`  Utilisez --force pour re-télécharger.`);
		return;
	}

	let downloadUrl: string;

	if (explicitUrl) {
		downloadUrl = explicitUrl;
	} else {
		let tag = version ?? (await getLatestReleaseTag(repo));
		// GitHub API renvoie souvent le tag avec le préfixe 'v' (ex: v1.1.0)
		// mais le nom du fichier archive n'inclut pas le préfixe (brick-data-1.1.0.zip)
		const cleanTag = tag.startsWith('v') ? tag.slice(1) : tag;
		console.log(`[init] Release: ${tag} (fichier: ${cleanTag})`);
		downloadUrl = `https://github.com/${repo}/releases/download/${tag}/ldraw-data-${cleanTag}.zip`;
	}

	await mkdir(dataDir, { recursive: true });

	const tmpFile = join(dataDir, ".data-download.zip");

	try {
		await downloadFile(downloadUrl, tmpFile);
		console.log("[init] Extraction (zip)...");
		await extractZip(tmpFile, dataDir);

		console.log(`[init] Données extraites dans ${dataDir}`);
	} finally {
		// Nettoyage du fichier temporaire
		if (existsSync(tmpFile)) {
			await rm(tmpFile);
		}
	}
}

// Exécution directe (bun run cli/init.ts)
if (process.argv[1]?.replace(/\\/g, "/").endsWith("/init.ts")) {
	runInit(process.argv.slice(2)).catch((err) => {
		console.error("[init] Erreur:", err.message);
		process.exit(1);
	});
}
