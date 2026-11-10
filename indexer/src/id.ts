// id.ts — Génération d'identifiants numériques, stables et idempotents par pièce LDraw.
//
// Un identifiant est obtenu par hachage FNV-1a (64 bits) puis masqué sur 53 bits.
// Le résultat est un entier *positif* (0 .. 2^53-1), donc :
//   - stable  : une même pièce produit toujours le même identifiant ;
//   - idempotent : on peut réinsérer sans créer de doublons (INSERT OR REPLACE) ;
//   - robuste : les caractères spéciaux des refs LDraw (tirés, suffixes, ...) sont
//     pris en compte car on hache les bytes UTF-8 de la ref normalisée.

const FNV_OFFSET64 = 0xcbf29ce484222325n;
const FNV_PRIME64 = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n; // mod 2^64
const U53_MASK = (1n << 53n) - 1n; // 2^53 - 1 = Number.MAX_SAFE_INTEGER

/** Normalise une ref LDraw : retire l'extension `.dat` et les espaces autour. */
function normalizeRef(refLDraw: string): string {
  return refLDraw.replace(/\.dat$/i, "").trim();
}

/**
 * Hash FNV-1a (64 bits) d'une string, puis masque le résultat sur 53 bits.
 * Retourne un entier positif dans [0, 2^53-1], garantissant `Number.MAX_SAFE_INTEGER`.
 */
export function hash64(input: string): number {
  let h = FNV_OFFSET64;
  for (const byte of new TextEncoder().encode(input)) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME64) & MASK64;
  }
  return Number(h & U53_MASK);
}

/** Identifiant stable d'une pièce LDraw à partir de son ref (avec ou sans `.dat`). */
export function computePartId(refLDraw: string): number {
  return hash64(normalizeRef(refLDraw));
}
