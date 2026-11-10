// keyword.ts — Normalisation des dimensions (noms et mots-clés) type LEGO (côté recherche).
//
// Réplique de brick-index-data/src/keyword.ts (NE PAS modifier sans refléter le
// changement dans l'autre repo). Les dimensions s'écrivent de façons variables
// (« 2 x 2 », « 2 x  2 », « 2×2 »…) ; on les unifie en forme canonique « 2x2 »
// afin que la requête MATCH corresponde aux jetons indexés.

/**
 * Normalise une notation de dimension :
 *   « 2 x  2 », « 2×2 », « 2 X 2 »         -> « 2x2 »
 *   « 2 x 2 x 2 », « 2×2×2 »               -> « 2x2x2 »
 *
 * — unifie le signe de multiplication (« · » et « × ») en « x » ;
 * — supprime les espaces autour du « x » entre chiffres et le remet en minuscule.
 *
 * Ne touche que les chaînes de dimensions : « box » ou « 16898 » restent intacts.
 */
export function normalizeDimension(text: string): string {
  return text
    .replace(/[·×]/g, "x") // · et × -> x (unifie le signe de multiplication)
    // « 2 x 2 x 2 » (1 à N dimensions) -> « 2x2x2 » : on retire les espaces et on minuscule le x.
    .replace(/(\d+\s*[xX]\s*)+\d+/g, match =>
      match.replace(/\s+/g, "").replace(/[xX]/g, "x"));
}
