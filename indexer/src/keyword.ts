// keyword.ts — Normalisation des dimensions (noms et mots-clés) type LEGO.
//
// Les noms/descriptions/keywords LDraw écrivent les dimensions de façons variables
// (« 2 x 2 », « 2 x  2 », « 2×2 », « 2 X 2 »…). À cause du tokeniseur FTS, ces
// variantes ne seraient pas reconnues comme équivalentes. Cette fonction les
// unifie en une forme canonique sans espaces (« 2x2 », « 2x2x2 »).
//
// La même fonction est dupliquée côté recherche (brick-index/src/lib) pour que
// la requête soit normalisée elle aussi : on recherche et on indexe de la même
// façon. Toute modification ici doit être reflétée de l'aut côté (cf. commit).

/**
 * Normalise une notation de dimension :
 *   « 2 x  2 », « 2×2 », « 2 X 2 »         -> « 2x2 »
 *   « 2 x 2 x 2 », « 2×2×2 »               -> « 2x2x2 »
 *
 * — unifie le signe de multiplication (« · » et « × ») en « x » ;
 * — supprime les espaces (quel que soit leur nombre) autour du « x » entre chiffres.
 *
 * Ne touche que les chaînes de dimensions : un mot comme « box » ou une ref
 * comme « 16898 » reste intact.
 */
export function normalizeDimension(text: string): string {
  return text
    .replace(/[·×]/g, "x") // · et × -> x (unifie le signe de multiplication)
    // « 2 x 2 x 2 » (1 à N dimensions) -> « 2x2x2 » : on retire les espaces internes
    // et on remet le « x » en minuscule (au cas où la source utilise « X »).
    // La sous-chaîne ne contient que chiffres et « x » : pas de risque sur le reste du mot.
    .replace(/(\d+\s*[xX]\s*)+\d+/g, match =>
      match.replace(/\s+/g, "").replace(/[xX]/g, "x"));
}
