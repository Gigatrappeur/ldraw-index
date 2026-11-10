# @gigatrappeur/brick-index-three

Helper front-end qui monte la géométrie jsonifiée d'une pièce LEGO/LDraw (issue
de [`brick-index get:geometry`](../README.md)) sur des objects
[Three.js](https://threejs.org/) : `THREE.BufferGeometry` + matériaux PBR, puis
un `THREE.Group` assemblant le modèle complet.

Ce package ne connaît ni la base de données ni le parser LDraw : il ne consiste
que la sortie `get:geometry`. Il est donc découplé des sources de
`brick-index` (c'est un sous-projet autonome avec son propre `package.json` et
`tsconfig.json`).

## Installation

Le package dépend de `three` et des types de `brick-index` :

```bash
bun add three @gigatrappeur/brick-index-three
```

## Démarrage rapide

Récupère d'abord la géométrie jsonifiée d'une pièce :

```bash
bun run get:geometry 3001 --out 3001.json   # au format studs, weld + normals de face
```

Puis monte le modèle :

```ts
import { readFileSync } from "node:fs";
import { buildPartModel, materialToThree } from "@gigatrappeur/brick-index-three";

const geometry = JSON.parse(readFileSync("3001.json", "utf8"));

// 1) Un THREE.Group : un mesh par couleur + une ligne d'arête par couleur.
const model = buildPartModel(geometry);

// 2) Ou un mesh seul, avec un matériau contrôlé finement :
import { geometryToBufferGeometry } from "@gigatrappeur/brick-index-three";

const mesh = new THREE.Mesh(
	geometryToBufferGeometry(geometry.meshes[0]),
	materialToThree(geometry.meshes[0].material, { transmission: false }),
);
```

## API

### `geometryToBufferGeometry(mesh)`

Construit un `THREE.BufferGeometry` depuis un mesh de `get:geometry` :

- `position` ← `mesh.positions` (comparateur 3),
- `normal` ← `mesh.normals` (présent sauf `normals: "none"`),
- `uv` ← `mesh.uvs` (présent si la pièce est texturée),
- index ← `mesh.indices`.

Les positions sont dans l'unité et le repère demandés à `get:geometry`
(defaut : `studs`, `y-up`), donc directement exploitables en Three.js.

### `edgesToLineSegments(edge)`

Construit un `THREE.LineSegments` depuis un jeu d'arêtes de `get:geometry`.

### `buildPartModel(geometry, options?)`

Construit un `THREE.Group` nommé `${ldrawRef}` contenant un mesh par couleur
(et, par défaut, une ligne d'arête par couleur).

Options :

| Option          | Défaut  | Description                                                        |
| --------------- | ------- | ------------------------------------------------------------------ |
| `material`      | `{}`    | Réglages transmis à `materialToThree` (ex. `{ transmission: true }`). |
| `skipMaterials` | `false` | Ne pas créer de matériaux Three.js : meshes avec blanc par défaut. |
| `includeEdges`  | `true`  | Attacher les lignes d'arêtes au modèle.                            |

### `materialToThree(material, options?)`

Traduit un `PartMaterial` PBR jsonifié en `THREE.MeshStandardMaterial` (ou
`THREE.MeshPhysicalMaterial` pour la transmission). Le `flatShading` du matériau
est délégué à Three.js :

- `flatShading: true` (defaut) → Three.js recalcule les normales de face → rendu
  plat typique des briques LEGO ;
- `flatShading: false` → combine avec des normales lissées fournies par la
  géométrie (`normals: "smooth"` dans `get:geometry`).

`transmission: true` (option) rend les couleurs transparentes comme du verre
(`MeshPhysicalMaterial`).

## Développement

Le sous-projet est auto-suffisant :

```bash
cd helpers/three
bun run typecheck   # tsc --noEmit
bun test            # tests offline (montage Three.js en pur JS)
```
