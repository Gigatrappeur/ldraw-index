#!/usr/bin/env bun
// index.ts — Indexation complète (Rebrickable + LDraw)

import { Database } from "bun:sqlite";
import { stat, readdir, exists } from "node:fs/promises";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import parser from "yargs-parser";
import LDrawParser from "@gigatrappeur/ldraw-parser";
import { classifyPart } from "./classify";
import { normalizeDimension } from "./keyword";
import {
  parseColorsCSV,
  parseElementsCSV,
  buildColorMapping,
  parsePartsCSV,
  parsePartCategoriesCSV,
} from "./csv";

const DATA_DIR = join(import.meta.dir, "..", "..", "data");
const LDRAW_DIR = join(DATA_DIR, "ldraw");
const PARTS_DIR = join(LDRAW_DIR, "parts");
const DB_PATH = join(DATA_DIR, "brick-data.sqlite");

const RB_COLORS = join(DATA_DIR, "rebrickable", "colors.csv");
const RB_ELEMENTS = join(DATA_DIR, "rebrickable", "elements.csv");
const RB_PARTS = join(DATA_DIR, "rebrickable", "parts.csv");
const RB_CATEGORIES = join(DATA_DIR, "rebrickable", "part_categories.csv");

// Config d'exclusion des catégories et liste des .dat exclus (générée, à la racine du repo).
const EXCLUDE_CONFIG_PATH = join(import.meta.dir, "..", "exclude-categories.json");
const EXCLUDED_LIST_PATH = join(import.meta.dir, "..", "..", "excluded-pieces.txt");

const SCHEMA = `
  -- Pièce LDraw canonique : UNE ligne par ldraw_ref.
  -- La clé primaire est le ref LDraw (texte).
  CREATE TABLE IF NOT EXISTS parts (
    ldraw_ref TEXT    PRIMARY KEY,
    name      TEXT NOT NULL,
    category  TEXT NOT NULL,
    keywords  TEXT,
    tag       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_category ON parts(category);

  -- Variants d'une pièce (couleurs / éléments LEGO).
  -- La clé logique est le couple (ldraw_ref, lego_ref) ; la couleur est incluse dans
  -- l'unicité pour ne rien perdre. Une colonne id auto-incrémenté sert de clé physique
  -- (stabilité des identifiants et jointures).
  -- lego_ref et color sont NOT NULL : seules les pièces disposant d'un mapping LEGO
  -- (couleur + élément) ont un variant ; les pièces sans mapping n'en ont pas du tout.
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

  -- Indexation full-text : une ligne par pièce conservée, sur 6 colonnes sémantiques.
  -- Chaque concept est sa propre colonne indexée : ça permet des recherches ciblées
  -- (par ref, par mot) et un classement bm25 par pondération.
  -- La cible (pièce canonique) concentre les données des pièces qui pontent vers elle
  -- (alias + « Moved to ») : son « name » et son « keywords » contiennent ceux de ses
  -- sources (édampés), et son « source_refs » retient leurs refs : chercher une source
  -- fait apparaît sa cible.
  CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts USING fts5(
    ldraw_ref,
    name,
    category,
    keywords,
    lego_refs,
    source_refs,
    tokenize='unicode61 remove_diacritics 1'
  );
`;

export interface IndexResult {
  inserted: number;      // pièces LDraw insérées (table parts)
  variants: number;      // variants insérés (table part_variants)
  matched: number;       // variants avec ref LEGO (mapping Rebrickable)
  skipped: number;       // pièces déjà indexées, non traitées (mode incremental)
  totalParts: number;    // total de pièces dans parts
  variantsTotal: number; // total de variants dans part_variants
  withLego: number;      // variants avec lego_ref
  withColor: number;     // variants avec couleur
  excluded: number;      // pièces ignorées pour leur catégorie
  excludedFiles: string[]; // refs des .dat de catégorie exclue (exclusion du zip)
  refRefs: Map<string, string[]>; // refs de sous-fichiers (regex) par pièce conservée,
  // pré-extraites de l'indexation pour ne pas relire ces pièces dans computeOrphanedSubfiles.
}

interface PartVariant {
  refLego: string | null;
  color: number | null;
}

// Identité d'une pièce utilisée comme source d'une relation (alias / « Moved to »).
interface SourceRef {
  ref: string;
  name: string;
  keywords: string;
}

// Données FTS d'une pièce, émises dans un second passage (cf. cartes inverses).
interface FtsRow {
  refLDraw: string;
  name: string;
  category: string;
  keywords: string;
  legoRefs: string;
}

function insertCanonicalPart(
  db: Database,
  values: { refLDraw: string; name: string; category: string; keywords: string; tag: string | null },
): void {
  db.run(
    `INSERT OR REPLACE INTO parts (ldraw_ref, name, category, keywords, tag) VALUES (?, ?, ?, ?, ?)`,
    [values.refLDraw, values.name, values.category, values.keywords, values.tag],
  );
}

function insertVariant(
  db: Database,
  values: { refLDraw: string; refLego: string | null; color: number | null },
): void {
  db.run(
    `INSERT OR REPLACE INTO part_variants (ldraw_ref, lego_ref, color) VALUES (?, ?, ?)`,
    [values.refLDraw, values.refLego, values.color],
  );
}

/**
 * Retire le préfixe spécial de description d'une pièce LDraw et détermine son tag sémantique.
 *
 * En LDraw, certains caractères placés en tête de description marquent une pièce spéciale
 * (utilisés par les programmes lisant parts.lst plutôt que la méta !LDRAW_ORG) :
 *   - `~Moved to <ref>`  -> redirect vers une autre pièce (cible dans la description) ;
 *   - `~`                -> subpart, partie obsolète, ou moule non vendu à l'unité ;
 *   - `=`                -> alias (pièce visuellement identique à une autre) ;
 *   - `|` / `~|`         -> partie tierce (non LEGO) ;
 *   - `_`                -> partie "physical colour" (déprécié).
 *
 * Pour un alias (`=`), la cible n'est pas dans la description mais dans le sous-fichier
 * référencé à matrice identité (`1 … <ref>.dat`) : elle est transmise via `aliasTarget`
 * (une erreur est levée si ce sous-fichier est absent ou au nombre de plusieurs).
 * Si aucune cible n'est connue, le tag se rabat sur le ref courant.
 *
 * Retourne le `name` nettoyé et un `tag` (ou null) :
 *   `moved:<ref>`, `obsolete`, `subpart`, `aliases:<ref_cible>`, `third_party`, `physical_colour`.
 */
export function classifyName(
  rawName: string | undefined | null,
  refLDraw: string,
  aliasTarget: string | null = null,
): { name: string; tag: string | null } {
  const raw = (rawName ?? "").trim();
  let tag: string | null = null;
  let name = raw;

  // Strip de tous les préfixes spéciaux menants (=, ~, |, _), y compris combinés (~_, ~|...).
  const strip = (s: string) => s.replace(/^[=~|_]+/, "").trim();

  if (/^~/.test(raw)) {
    const moved = /^~Moved to (\S+)$/i.exec(raw);
    if (moved) {
      const target = moved[1]!.trim();
      name = strip(raw.replace(/^~Moved to \S+$/i, "")) || `Moved to ${target}`;
      tag = `moved:${target}`;
    } else if (/obsolete/i.test(raw)) {
      tag = "obsolete";
      name = strip(raw);
    } else if (/^~\|/.test(raw)) {
      tag = "third_party";
      name = strip(raw);
    } else {
      tag = "subpart";
      name = strip(raw);
    }
    return { name, tag };
  }

  if (/^=/.test(raw)) return { name: strip(raw), tag: `aliases:${aliasTarget ?? refLDraw}` };
  if (/^\|/.test(raw)) return { name: strip(raw), tag: "third_party" };
  if (/^_/.test(raw)) return { name: strip(raw), tag: "physical_colour" };

  return { name, tag };
}

/**
 * Détermine la pièce ciblée par une pièce alias (`=`).
 *
 * En LDraw, une pièce aliasée ré-exporte sa géométrie via une référence de sous-fichier
 * à matrice identité :
 *   1 16 0 0 0 1 0 0 0 1 0 0 0 1 003440a.dat
 * Le ref cité (sans l'extension `.dat`) est la pièce cible.
 *
 * Une pièce alias doit référencer EXACTEMENT UN sous-fichier. S'il y en a plusieurs (ou
 * zéro), on lève une erreur avec le nom du fichier : on refuse qu'un alias pointe sur lui
 * même.
 *
 * Retourne le ref cible (toujours non nul).
 */
export function extractAliasTarget(
  commands: Array<{ type: number; file?: string } | undefined>,
  filename: string,
): string {
  const refs = commands
    .filter(c => c?.type === 1 && typeof c.file === "string")
    .map(c => c!.file!.replace(/\.dat$/i, "").trim())
    .filter(r => r.length > 0);

  if (refs.length === 0) {
    throw new Error(
      `[classify] Pièce alias sans sous-fichier cible : ${filename}`,
    );
  }
  if (refs.length > 1) {
    throw new Error(
      `[classify] Pièce alias sans cible unique : ${filename} référence ${refs.length} sous-fichiers (${refs.join(", ")})`,
    );
  }
  return refs[0]!;
}

function insertPartsFts(
  db: Database,
  row: {
    refLDraw: string;
    name: string;
    category: string;
    keywords: string;
    legoRefs: string;
    sourceRefs: string;
  },
): void {
  db.run(
    `INSERT INTO parts_fts
       (ldraw_ref, name, category, keywords, lego_refs, source_refs)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      row.refLDraw, row.name, row.category, row.keywords,
      row.legoRefs, row.sourceRefs,
    ],
  );
}

// Enregistre cette pièce comme source d'une relation (alias / « Moved to ») vers sa cible,
// afin de remonter la cible quand on recherche la source.
function registerSource(
  aliasers: Map<string, SourceRef[]>,
  movers: Map<string, SourceRef[]>,
  ref: string,
  name: string,
  keywords: string,
  tag: string | null,
): void {
  const source: SourceRef = { ref, name, keywords };
  if (tag?.startsWith("aliases:") && tag.length > "aliases:".length) {
    const target = tag.slice("aliases:".length);
    if (target && target !== ref) {
      const list = aliasers.get(target) ?? [];
      aliasers.set(target, list);
      list.push(source);
    }
  } else if (tag?.startsWith("moved:") && tag.length > "moved:".length) {
    const target = tag.slice("moved:".length);
    if (target && target !== ref) {
      const list = movers.get(target) ?? [];
      movers.set(target, list);
      list.push(source);
    }
  }
}

// Édame une chaîne (mots-clés ou refs séparés par des espaces) : conserve la première
// occurrence de chaque mot/sigle, retire les vides. Sert à fusionner sans doubler.
function dedupWords(source: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of source.split(/\s+/)) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out.join(" ");
}

// Édame une liste de noms : conserve la première occurrence de chaque nom.
function dedupNames(names: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.join(" ");
}

// Résout la cible canonique finale d'une pièce supprimée en suivant sa chaîne de
// transfert (« Moved to » / alias). Retourne la première référence atteinte qui n'est
// plus une pièce supprimée (une pièce conservée), ou null si une boucle est détectée.
function resolveFinalTarget(
  ref: string,
  directTargets: Map<string, string>,
): string | null {
  const seen = new Set<string>();
  let current = ref;
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const next = directTargets.get(current);
    if (!next) return current;
    current = next;
  }
}

// Rassemble, pour une pièce cible, la liste ordonnée et épurée de ses sources (alias +
// « Moved to »), en étendant transitivement les sources elles-mêmes supprimées.
//
// Une source « supprimée » (movée/alias, donc hors de `parts`) ne conserve pas de ligne :
// ses propres sources pontent alors vers elle et doivent être reportées jusqu'à la cible.
// On suit donc la chaîne des sources jusqu'aux pièces conservées, avec détection de cycles.
// `removedRefs` est l'ensemble des refs supprimées.
function collectSources(
  target: string,
  aliasers: Map<string, SourceRef[]>,
  movers: Map<string, SourceRef[]>,
  removedRefs: Set<string>,
): SourceRef[] {
  const sources: SourceRef[] = [];
  const seen = new Set<string>();
  const push = (source: SourceRef): void => {
    if (seen.has(source.ref)) return;
    seen.add(source.ref);
    sources.push(source);
    // La source est elle-même une pièce supprimée : ses sources pontent vers elle, donc,
    // transitivement, vers la cible. On étend la recherche.
    if (removedRefs.has(source.ref)) {
      for (const sub of [
        ...(movers.get(source.ref) ?? []),
        ...(aliasers.get(source.ref) ?? []),
      ]) {
        push(sub);
      }
    }
  };
  for (const s of [...(movers.get(target) ?? []), ...(aliasers.get(target) ?? [])]) {
    push(s);
  }
  return sources;
}

async function loadRebrickableData(_ldrawParser: LDrawParser): Promise<{
  elementsByPart: Map<string, Array<{ elementId: string; colorId: number }>>;
  partToCategory: Map<string, { catName: string; partName: string }>;
}> {
  console.log("[index] Chargement CSV Rebrickable...");
  await Promise.all([
    exists(RB_COLORS).then(v => { if (!v) throw new Error(`CSV couleurs introuvable: ${RB_COLORS}`); }),
    exists(RB_ELEMENTS).then(v => { if (!v) throw new Error(`CSV éléments introuvable: ${RB_ELEMENTS}`); }),
  ]);

  const rbColors = parseColorsCSV(RB_COLORS);
  const rbElements = parseElementsCSV(RB_ELEMENTS);

  const elementsByPart = new Map<string, Array<{ elementId: string; colorId: number }>>();
  for (const el of rbElements) {
    let list = elementsByPart.get(el.partNum);
    if (!list) {
      list = [];
      elementsByPart.set(el.partNum, list);
    }
    list!.push({ elementId: el.elementId, colorId: el.colorId });
  }
  console.log(`[index] ${elementsByPart.size} numéros de pièce uniques`);

  console.log("[index] Chargement catégories et pièces Rebrickable...");
  await Promise.all([
    exists(RB_PARTS).then(v => { if (!v) throw new Error(`CSV pièces introuvable: ${RB_PARTS}`); }),
    exists(RB_CATEGORIES).then(v => { if (!v) throw new Error(`CSV catégories introuvable: ${RB_CATEGORIES}`); }),
  ]);

  const rbCategories = parsePartCategoriesCSV(RB_CATEGORIES);
  const rbParts = parsePartsCSV(RB_PARTS);
  const partToCategory = new Map<string, { catName: string; partName: string }>();
  for (const [partNum, part] of rbParts) {
    if (part.catId && rbCategories.has(part.catId)) {
      partToCategory.set(partNum, {
        catName: rbCategories.get(part.catId)!.name,
        partName: part.name,
      });
    }
  }
  console.log(`[index] ${partToCategory.size} pièces avec catégorie`);

  return { elementsByPart, partToCategory };
}

async function loadColorMapping(
  ldrawParser: LDrawParser,
): Promise<Map<number, number>> {
  console.log("[index] Chargement LDConfig...");
  const colorTable = await ldrawParser.colorTable.getTable();
  console.log(`[index] ${colorTable.size} couleurs LDraw chargées`);

  const rbColors = parseColorsCSV(RB_COLORS);
  const { rbToLDrawColor } = buildColorMapping(rbColors, colorTable);
  console.log(`[index] ${rbToLDrawColor.size} couleurs Rebrickable mappées`);
  return rbToLDrawColor;
}

async function selectLdrawFiles(
  filterParts?: string[],
  existingRefs?: Set<string>,
): Promise<string[]> {
  const all = (await readdir(PARTS_DIR, { withFileTypes: true }))
    .filter(d => d.isFile() && d.name.endsWith(".dat"))
    .map(d => d.name);

  if (filterParts?.length) {
    const set = new Set(filterParts);
    return all.filter(f => set.has(f.replace(".dat", "")));
  }
  if (!existingRefs) return all;
  return all.filter(f => !existingRefs.has(f.replace(".dat", "")));
}

// Charge les catégories à exclure depuis exclude-categories.json.
// Un fichier absent = aucune exclusion ; on ignore donc cette pièce-là sans bloquer.
function loadExcludedCategories(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(EXCLUDE_CONFIG_PATH, "utf-8")) as {
      categories?: string[];
    };
    const list = (parsed?.categories ?? []).map(c => c.trim()).filter(Boolean);
    console.log(
      `[index] Catégories exclues (${list.length}) : ${list.join(", ") || "aucune"}`,
    );
    return new Set(list);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      console.log("[index] Fichier d'exclusion absent : aucune exclusion");
      return new Set();
    }
    throw err;
  }
}

/**
 * Indique si un chemin (relatif à data/, barres obliques) désigne un sous-fichier du zip :
 * géométrie (`p/`, `p/8/`, `p/48/`), subpart (`parts/s/`) ou texture (`parts/textures/`).
 * Les pièces principales (`ldraw/parts/<ref>.dat`) ne sont PAS des sous-fichiers : elles sont
 * les racines de l'analyse et gérées par l'exclusion par catégorie.
 */
function isSubFile(rel: string): boolean {
  return (
    rel.startsWith("ldraw/parts/s/") ||
    rel.startsWith("ldraw/parts/textures/") ||
    rel.startsWith("ldraw/p/")
  );
}

/**
 * Résut une référence brute (contenu d'une commande LDraw) vers un chemin relatif à data/,
 * avec des barres obliques (le zip tourne sous Linux). Respecte les préfixes de dossier LDraw :
 *   `s\..` / `s/..`      -> parts/s/…              (subpart)
 *   `8\..` / `48/..`     -> p/<N>/…                (géométrie du sous-dossier N)
 *   (sans préfixe) .png/.tga -> parts/textures/…   (texture)
 *   (sans préfixe) .dat           -> p/…            (géométrie racine, ou une pièce → non trouvée ici)
 */
function resolveRef(rawRef: string): string | null {
  const ref = rawRef.trim();
  if (!ref) return null;

  if (/^s[\\/]/.test(ref)) {
    return ["ldraw", "parts", "s", ref.slice(2)].join("/");
  }
  const num = /^([0-9]+)[\\/](.+)$/.exec(ref);
  if (num) {
    return ["ldraw", "p", num[1]!, num[2]!].join("/");
  }
  if (/\.(png|tga)$/i.test(ref)) {
    return ["ldraw", "parts", "textures", ref].join("/");
  }
  return ["ldraw", "p", ref].join("/");
}

// Récupère tous les noms de fichiers référencés par le contenu d'un .dat (lecture brute).
// Pour chaque ligne, le dernier token est une référence s'il finit par .dat/.png/.tga :
// cela couvre les commandes de matrice (géométrie, subparts, alias) ET les lignes de texture
// `!TEXMAP`. Les lignes meta `Name:` produisent une référence à soi-même, inoffensive (épurée
// par l'ensemble des fichiers visités).
function extractFileRefs(content: string): string[] {
  const refs: string[] = [];
  const lineRe = /\S+\.(?:dat|png|tga)\s*$/;
  for (const line of content.split(/\r?\n/)) {
    const m = lineRe.exec(line);
    if (m) refs.push(m[0]!);
  }
  return refs;
}

// ── Lecteur léger pour l'indexation ──────────────────────────────────────────
// On n'a pas besoin des points/commandes complets : seulement la description, les
// mots-clés et les sous-fichiers référencés (commandes type-1). Ce lecteur réplique
// exactement ces comportements du parser LDraw, mais sans parser les coordonnées ni
// construire le graphe de commandes (c'est le gros du coût de `parseOnly`).

// Ajoute les mots-clés d'une ligne `0 !KEYWORDS …` (coupés sur « , », trimés, sans
// doubles), identiquement au parser LDraw.
function addKeywords(
  meta: { keywords?: string[] },
  body: string,
): void {
  const kws = body
    .replace(/^!KEYWORDS\s+/i, "")
    .split(",")
    .map(k => k.trim())
    .filter(Boolean);
  if (!meta.keywords) meta.keywords = [];
  for (const kw of kws) {
    if (!meta.keywords.includes(kw)) meta.keywords.push(kw);
  }
}

/**
 * Extrait description + mots-clés des lignes type-0 d'un .dat, en répliquant le
 * comportement minimal du parser LDraw :
 *   - description : première ligne type-0, tant qu'elle ne commence pas par « ! » ou « // » ;
 *   - keywords    : lignes « 0 !KEYWORDS … » découpées sur « , », trimées, sans doubles.
 */
export function scanMeta(content: string): {
  description?: string;
  keywords?: string[];
} {
  const meta: { description?: string; keywords?: string[] } = {};
  let isFirstLine = true;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lineIsFirst = isFirstLine;
    isFirstLine = false;
    // Seules les lignes type-0 (commençant par « 0 ») sont traitées.
    if (trimmed.charCodeAt(0) !== 48) continue;
    const body = trimmed.replace(/^0\s*/, "").trim();
    // La description n'est fixée que sur la première ligne de contenu.
    if (lineIsFirst && !body.startsWith("!") && !body.startsWith("//")) {
      meta.description = body;
    }
    if (/^!KEYWORDS\b/i.test(body)) addKeywords(meta, body);
  }
  return meta;
}

/**
 * Extrait les références de sous-fichiers issues des commandes type-1
 * (« 1 … <file>.dat »), nécessaires pour résoudre la cible d'un alias (pièce « = »).
 * Réplique l'extraction du parser : le nom de fichier est tout ce qui suit le 15e jeton.
 */
export function extractSubFileRefs(content: string): string[] {
  const refs: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.charCodeAt(0) !== 49) continue; // type-1 uniquement
    const file = trimmed.split(/\s+/).slice(14).join(" ");
    if (file) refs.push(file);
  }
  return refs;
}

// Construit l'ensemble des sous-fichiers référencables présents dans le repo (géométrie,
// subparts, textures), chemins relatifs à data/. Géométrie : p/ p/8/ p/48/ ; subparts : parts/s/
// ; textures : parts/textures/.
async function collectAllSubFiles(): Promise<Set<string>> {
  const files = new Set<string>();
  const roots = [
    ["ldraw", "p"],
    ["ldraw", "parts", "s"],
    ["ldraw", "parts", "textures"],
  ];
  const walk = async (prefix: string[]): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(join(DATA_DIR, ...prefix), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk([...prefix, e.name]);
      else if (e.isFile()) files.add([...prefix, e.name].join("/"));
    }
  };
  for (const root of roots) await walk(root);
  return files;
}

/**
 * Fermeture transitive des sous-fichiers à partir des pièces conservées (tables parts, déjà
 * filtrées par catégorie). Une géométrie / subpart / texture est « utilisée » si elle est
 * atteignable (transitivement) depuis une pièce conservée ; orpheline sinon.
 *
 * Retourne les sous-fichiers orphelins (à exclure du zip) et le nombre de fichiers lus.
 */
async function computeOrphanedSubfiles(
  keptRefs: Set<string>,
  refByPart: Map<string, string[]>,
): Promise<{ orphaned: string[]; processed: number }> {
  const allSubFiles = await collectAllSubFiles();

  const visited = new Set<string>();
  const worklist: string[] = [];
  const existsSync = (rel: string): boolean => {
    try {
      return statSync(join(DATA_DIR, rel)).isFile();
    } catch {
      return false;
    }
  };

  // Racines : les pièces conservées. Leurs sous-fichiers directs sont pré-extraits de
  // l'indexation (refByPart) pour ne pas relire ces pièces ; sinon repli sur la lecture
  // du .dat (utile en mode incrément où certaines pièces ne sont pas retraitées).
  for (const ref of keptRefs) {
    const rawRefs = refByPart.get(ref);
    if (rawRefs) {
      for (const rawRef of rawRefs) {
        const target = resolveRef(rawRef);
        if (!target || !isSubFile(target) || visited.has(target) || !existsSync(target)) continue;
        visited.add(target);
        worklist.push(target);
      }
      continue;
    }
    const rel = `ldraw/parts/${ref}.dat`;
    if (!visited.has(rel)) {
      visited.add(rel);
      worklist.push(rel);
    }
  }

  let processed = 0;
  while (worklist.length > 0) {
    const rel = worklist.pop()!;
    processed++;
    let content: string;
    try {
      content = readFileSync(join(DATA_DIR, rel), "utf-8");
    } catch {
      continue;
    }
    for (const ref of extractFileRefs(content)) {
      const target = resolveRef(ref);
      if (!target || !isSubFile(target) || visited.has(target) || !existsSync(target)) continue;
      visited.add(target);
      worklist.push(target);
    }
  }

  const orphaned = [...allSubFiles].filter(f => !visited.has(f));
  return { orphaned, processed };
}

async function indexParts(
  db: Database,
  filterParts?: string[],
  excludedCategories?: Set<string>,
): Promise<IndexResult> {
  const ldrawParser = new LDrawParser({ libraryRoot: LDRAW_DIR });
  const { elementsByPart, partToCategory } = await loadRebrickableData(ldrawParser);
  const rbToLDrawColor = await loadColorMapping(ldrawParser);

  const existingRefs = new Set(
    db.query<{ ldraw_ref: string }, []>("SELECT ldraw_ref FROM parts").all().map(r => r.ldraw_ref),
  );

  const filenames = await selectLdrawFiles(filterParts, existingRefs);
  const skipped = existingRefs.size;
  const mode = filterParts?.length ? "filtre --parts" : `${existingRefs.size} déjà indexés`;
  console.log(`[index] ${filenames.length} fichiers LDraw à indexer (${mode})`);

  let inserted = 0;
  let matched = 0;
  let lastProgressTime = Date.now();

  // Pièces ignorées pour leur catégorie : compteur + refs des .dat à exclure du zip.
  let excluded = 0;
  const excludedFiles: string[] = [];

  // Cartes inverses des sources qui pontent vers une pièce (alias + « Moved to »),
  // et lignes FTS à émettre dans un second passage (une fois toutes les cartes remplies).
  const aliasers = new Map<string, SourceRef[]>();
  const movers = new Map<string, SourceRef[]>();
  const ftsRows: FtsRow[] = [];

  // Refs de sous-fichiers (regex) par pièce conservée, pré-extraites pendant l'indexation
  // pour ne pas relire ces pièces dans computeOrphanedSubfiles (fermeture transitive).
  const refRefs = new Map<string, string[]>();

  // Refs des pièces supprimées (alias / « Moved to ») et, pour chacune, sa cible directe
  // (issue du tag) : utiles pour reporter leurs variants et étendre les sources FTS.
  const removedRefs = new Set<string>();
  const directTargets = new Map<string, string>();
  // Variants de toutes les pièces, insérés en second passage (report sur la cible pour
  // les pièces supprimées).
  const variantsByRef = new Map<string, PartVariant[]>();

  console.log("[index] Indexation des pièces...");
  db.run("BEGIN");

  for (let i = 0; i < filenames.length; i++) {
    const filename = filenames[i]!;
    const refLDraw = filename.replace(".dat", "");

    if (Date.now() - lastProgressTime >= 3000) {
      process.stdout.write(
        `\r  Progression: ${i}/${filenames.length} (${((i / filenames.length) * 100).toFixed(1)}%)`,
      );
      lastProgressTime = Date.now();
    }

    try {
      // Lecture brute + lecteur léger (description / mots-clés / refs type-1),
      // à la place de `parseOnly` (qui parse tout le fichier : points + graphes).
      const content = readFileSync(join(PARTS_DIR, filename), "utf-8");
      const { description, keywords } = scanMeta(content);
      // keywords ([]) -> chaîne joinée pour la colonne TEXT « keywords ».
      // Chaque mot-clé est normalisé : « 2 x  2 » / « 2×2 » / « 2 x 2 x 2 » -> « 2x2 » / « 2x2x2 »,
      // afin que dimensions équivalentes partagent le même jeton (index + FTS). Cf. normalizeDimension.
      const keywordsJoined = (keywords ?? [])
        .map(kw => normalizeDimension(kw))
        .join(" ");
      const isAlias = /^=/.test((description ?? "").trim());
      const aliasTarget = isAlias
        ? extractAliasTarget(
            extractSubFileRefs(content).map(f => ({ type: 1 as const, file: f })),
            refLDraw,
          )
        : null;
      // Même normalisation que les keywords : « 2 x 2 » -> « 2x2 » (index FTS + relations alias/moved).
      const { name: rawName, tag } = classifyName(description, refLDraw, aliasTarget);
      const name = normalizeDimension(rawName);
      const rbKeyword = keywords?.find(k => k.toLowerCase().startsWith("rebrickable"));
      const refRebrickable = rbKeyword?.substring(12) || refLDraw;

      const category = (() => {
        const catInfo = partToCategory.get(refRebrickable);
        return catInfo?.catName || classifyPart(name).category;
      })();

      // Pièce d'une catégorie exclue : on l'ignore totalement (ni parts, ni variants,
      // ni FTS, ni comme source dans une autre pièce).
      if (excludedCategories?.has(category)) {
        excluded++;
        // On écrit les refs avec des barres obliques : le zip de release tourne sous Linux.
        excludedFiles.push(["ldraw", "parts", filename.replace(/\\/g, "/")].join("/"));
        continue;
      }

      const partName = partToCategory.get(refRebrickable)?.partName || "";

      // Collecte des variants (couleurs / éléments LEGO) pour cette pièce.
      let variants: PartVariant[] = [];
      if (refRebrickable && elementsByPart.has(refRebrickable)) {
        const elements = elementsByPart.get(refRebrickable)!;
        variants = elements.map(el => ({
          refLego: el.elementId,
          color: rbToLDrawColor.get(el.colorId) ?? el.colorId,
        }));
      } else {
        variants = [{ refLego: null, color: null }];
      }
      // On ne garde que les variants complets (lego_ref et color non nulls) : la contrainte
      // NOT NULL du schema empêche l'insertion d'un variant partiel. Une pièce sans mapping
      // LEGO (fallback ci-dessus) n'aura donc aucune ligne dans part_variants.
      variants = variants.filter(v => v.refLego != null && v.color != null);
      const legoRefs = Array.from(
        new Set(variants.map(v => v.refLego).filter((r): r is string => r != null)),
      ).join(" ");

      // Pièce supprimée (alias / « Moved to ») : hors de `parts`, mais sa relation vers
      // sa cible est conservée (source inverse + transfert de variants).
      const isRemoved = tag?.startsWith("moved:") || tag?.startsWith("aliases:");
      if (isRemoved) {
        const target = tag!.slice(
          tag!.startsWith("moved:") ? "moved:".length : "aliases:".length,
        );
        if (target) {
          removedRefs.add(refLDraw);
          directTargets.set(refLDraw, target);
        }
      }

      // Pièce canonique (ligne unique par ldraw_ref).
      if (!isRemoved) {
        insertCanonicalPart(db, {
          refLDraw,
          name,
          category,
          keywords: keywordsJoined,
          tag,
        });
      }

      // Les variants sont insérés plus bas (second passage) : pour une pièce supprimée, on
      // les reporte sur la cible (finale) afin de ne rien perdre.
      variantsByRef.set(refLDraw, variants);

      // Renseigne la source (cette pièce) vers sa cible (recherches inverses), qu'elle
      // soit conservée ou supprimée, et stocke les données FTS à émettre dans un second
      // passage (pièces conservées uniquement).
      registerSource(aliasers, movers, refLDraw, name, keywordsJoined, tag);
      if (!isRemoved) {
        ftsRows.push({ refLDraw, name, category, keywords: keywordsJoined, legoRefs });
      }

      // On retient les refs de sous-fichiers de cette pièce conservée pour la
      // fermeture transitive (sinon on devrait la relire dans computeOrphanedSubfiles).
      if (!isRemoved) {
        refRefs.set(refLDraw, extractFileRefs(content));
      }

      if (!isRemoved) inserted++;
      matched += variants.filter(v => v.refLego != null).length;
    } catch (err) {
      console.error(`\n✗ Erreur processing ${filename}:`, err);
    }
  }

  // Insertion différée des variants : pour une pièce supprimée, on reporte ses variants
  // sur la cible finale (résolue transitivement). La contrainte UNIQUE + INSERT OR REPLACE
  // élimine les doublons.
  const keptRefs = new Set(ftsRows.map(r => r.refLDraw));
  let variantsPersisted = 0;
  // Clés déjà écrites : évite de compter en doublon les variants identiques transférés
  // (les collisions sont éliminées par la contrainte UNIQUE de part_variants).
  const seenVariantKeys = new Set<string>();
  for (const [ref, vs] of variantsByRef) {
    const target = removedRefs.has(ref)
      ? resolveFinalTarget(ref, directTargets) ?? ref
      : ref;
    // On n'insère que si la cible est une pièce conservée (évite les variants orphelins).
    if (!keptRefs.has(target)) continue;
    for (const v of vs) {
      const key = `${target}\u0000${v.refLego ?? ""}\u0000${v.color ?? ""}`;
      if (seenVariantKeys.has(key)) continue;
      seenVariantKeys.add(key);
      insertVariant(db, { refLDraw: target, refLego: v.refLego, color: v.color });
      variantsPersisted++;
    }
  }

  // Émission FTS : une ligne par pièce conservée. Son « name » et son « keywords »
  // concentrent ceux de ses sources (alias + « Moved to »), épurées ; son « source_refs »
  // retient leurs refs. Reconstruites à partir des cartes inverses construites pendant la
  // première boucle (avec extension transitive des sources elles-mêmes supprimées).
  for (const row of ftsRows) {
    const sources = collectSources(row.refLDraw, aliasers, movers, removedRefs);
    insertPartsFts(db, {
      refLDraw: row.refLDraw,
      name: dedupNames([row.name, ...sources.map(s => s.name)]),
      category: row.category,
      keywords: dedupWords([row.keywords, ...sources.map(s => s.keywords)].join(" ")),
      legoRefs: dedupWords(row.legoRefs),
      sourceRefs: sources.map(s => s.ref).join(" "),
    });
  }

  db.run("COMMIT");
  console.log(
    `\n[index] ${inserted} pièces insérées, ${variantsPersisted} variants, ` +
    `${matched} avec mapping Rebrickable`,
  );

  // Liste des .dat exclus (catégorie), transmise au pipeline de release via run()
  // (réunion avec les sous-fichiers orphelins, écrite en un seul fichier).
  if (excluded > 0) {
    console.log(
      `[index] ${excluded} pièces exclues (catégorie) -> exclus du zip`,
    );
  }

  const stats = db.query<{ total: number; variants: number; lego: number; color: number }, []>(`
    SELECT
      (SELECT COUNT(*) FROM parts) AS total,
      (SELECT COUNT(*) FROM part_variants) AS variants,
      (SELECT COUNT(*) FROM part_variants WHERE lego_ref IS NOT NULL) AS lego,
      (SELECT COUNT(*) FROM part_variants WHERE color IS NOT NULL) AS color
  `).get();

  if (!stats) {
    return {
      inserted, variants: variantsPersisted, matched, skipped,
      totalParts: 0, variantsTotal: 0, withLego: 0, withColor: 0, excluded,
      excludedFiles, refRefs,
    };
  }

  return {
    inserted, variants: variantsPersisted, matched, skipped,
    totalParts: stats.total,
    variantsTotal: stats.variants,
    withLego: stats.lego,
    withColor: stats.color,
    excluded,
    excludedFiles,
    refRefs,
  };
}

function cleanDatabase(): void {
  const db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA cache_size = -65536"); // ~64 Mo de cache de pages
  db.run("PRAGMA temp_store = MEMORY");
  db.exec(`
    DROP TABLE IF EXISTS parts_fts;
    DROP TABLE IF EXISTS part_variants;
    DROP TABLE IF EXISTS partVariants;
    DROP TABLE IF EXISTS parts;
  `);
  db.close();
}

function openDatabase(): Database {
  const db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA cache_size = -65536"); // ~64 Mo de cache de pages
  db.run("PRAGMA temp_store = MEMORY");
  db.exec(SCHEMA);
  return db;
}

export async function run(args: string[] = []): Promise<void> {
  console.log("[index] Démarrage de l'indexation\n");

  const parsed = parser(args, {
    boolean: ["clean-before"],
    array: ["parts"],
    configuration: { "camel-case-expansion": false },
  });

  const cleanBefore = parsed["clean-before"] === true || parsed["cleanBefore"] === true;
  const rawParts = parsed["parts"] as unknown;
  const partsRaw = (Array.isArray(rawParts) ? rawParts : rawParts != null ? [rawParts] : []).map(String);
  // yargs-parser ne splitte jamais une valeur sur virgule ; on le fait manuellement
  // pour accepter "--parts 4032,2450" comme "--parts 4032 --parts 2450".
  const parts = partsRaw.flatMap(p => p.split(",")).map(p => p.trim()).filter(Boolean);

  if (cleanBefore) console.log("[index] Mode clean: drop des tables avant indexation");
  if (parts.length > 0) console.log(`[index] Filtre --parts: ${parts.length} référence(s)`);

  if (cleanBefore) cleanDatabase();

  const db = openDatabase();
  console.log("[index] Schema initialisé");

  const excludedCategories = loadExcludedCategories();
  const result = await indexParts(
    db,
    parts.length > 0 ? parts : undefined,
    excludedCategories,
  );

  // Filtrage des sous-fichiers orphelins : géométrie / subparts / textures non référencés,
  // transitivement, par une pièce conservée (table parts, déjà filtrée par catégorie).
  const keptRefs = new Set(
    db.query<{ ldraw_ref: string }, []>("SELECT ldraw_ref FROM parts")
      .all()
      .map(r => r.ldraw_ref),
  );
  console.log(
    `[index] ${keptRefs.size} pièces conservées -> analyse des sous-fichiers (${
      [
        ["ldraw", "p"],
        ["ldraw", "parts", "s"],
        ["ldraw", "parts", "textures"],
      ]
        .map(p => join(DATA_DIR, ...p))
        .join(", ")
    })`,
  );
  const { orphaned: subFilesOrphaned, processed } =
    await computeOrphanedSubfiles(keptRefs, result.refRefs);

  // Réunion des exclusions : pièces exclues par catégorie + sous-fichiers orphelins +
  // fichiers Rebrickable (inutiles après l'indexation), réécrites en un seul fichier
  // (barres obliques, relatif à data/). Écrasée à chaque run.
  // Fichiers Rebrickable (entrées CSV de l'indexation) : inutiles une fois la base
  // d'indexation générée, on les exclut aussi du zip. Arborescence plate dans
  // data/rebrickable ; on liste les fichiers présents (sans blinder si le dossier est absent).
  const rbFiles = (await readdir(join(DATA_DIR, "rebrickable"), { withFileTypes: true }))
    .filter(d => d.isFile())
    .map(d => ["rebrickable", d.name].join("/"));

  const exclusionSet = new Set<string>([
    ...result.excludedFiles,
    ...subFilesOrphaned,
    ...rbFiles,
  ]);
  writeFileSync(
    EXCLUDED_LIST_PATH,
    exclusionSet.size ? [...exclusionSet].join("\n") + "\n" : "",
  );

  db.close();

  console.log("\n[index] Statistiques finales:");
  console.log(`  Pièces insérées (cette session): ${result.inserted}`);
  console.log(`  Variants insérés (cette session): ${result.variants}`);
  console.log(`  Déjà indexés (non traités) : ${result.skipped}`);
  console.log(`  Total pièces        : ${result.totalParts}`);
  console.log(`  Total variants      : ${result.variantsTotal}`);
  console.log(`  Avec ref LEGO       : ${result.withLego}`);
  console.log(`  Avec couleur        : ${result.withColor}`);
  console.log(`  Pièces exclues (catégorie) : ${result.excluded}`);
  console.log(
    `  Sous-fichiers orphelins    : ${subFilesOrphaned.length} (${processed} lus)`,
  );
  console.log(`  Fichiers Rebrickable        : ${rbFiles.length} (inutiles après index)`);
  console.log(`  Total exclus du zip        : ${exclusionSet.size}`);

  const dbSize = (await stat(DB_PATH)).size;
  console.log(`  Base SQLite: ${(dbSize / 1024 / 1024).toFixed(2)} Mo`);
  console.log("\n[index] ✅ Indexation terminée");
}

// Exécution directe (bun run index.ts)
if (process.argv[1]?.replace(/\\/g, "/").endsWith("index.ts")) {
  run(process.argv.slice(2)).catch((err) => {
    console.error("[index] Erreur fatale:", err);
    process.exit(1);
  });
}
