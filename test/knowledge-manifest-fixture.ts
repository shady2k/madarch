/**
 * A kinds manifest for a fixture context (decision 0033): the declarations a check needs, held as the manifest reader
 * holds them. A check names the fields its page draws by — `views`, `sequence`, `system`, `definition-block`, `listing`,
 * `nav` — because the engine and the app choose nothing by a kind's name; a kind a check does not declare has none of
 * them, and the page says so.
 */
import type { KindDecl, KindsManifest } from '../src/product/manifest/kinds.js';

export function fixtureManifest(declarations: Readonly<Record<string, Partial<KindDecl>>> = {}): KindsManifest {
  const kinds = new Map(Object.entries(declarations).map(([name, decl]): [string, KindDecl] => [name, {
    name,
    template: `templates/${name}.liquid`,
    source: 'graph',
    title: 'label',
    relations: [],
    line: 1,
    ...decl,
  }]));
  return { file: 'madarch/kinds.yaml', roles: new Map(), properties: new Map(), kinds, groups: new Map(), excludeDocuments: [], ignoreBlocks: [], findings: [] };
}
