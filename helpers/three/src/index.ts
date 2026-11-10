// Index public du helper Three.js de brick-index.
//
// Expose les fonctions pour monter une géométrie brick-index (JSON de
// `get:geometry`) sur des objects Three.js : conversion matériau, géométrie et
// montage complet du modèle.

export { materialToThree } from "./material"
export type { MaterialToThreeOptions } from "./material"

export {
	geometryToBufferGeometry,
	edgesToLineSegments,
	buildPartModel,
} from "./geometry"
export type { BuildModelOptions } from "./geometry"
