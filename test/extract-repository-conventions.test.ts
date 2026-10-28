/**
 * One test per entry of the repository conventions (madarch-mwhd.3 review 3): the folders whose
 * manifests declare someone else's unit, the folders that declare a migration series, a Prisma
 * schema's place, and which parsed statements make a `.sql` file a schema rather than a seed.
 *
 * Nothing here is a path shape of one repository: each case builds a tree, names the entry it
 * exercises, and asserts the behaviour that entry declares.
 */
import {describe, expect, test} from 'bun:test';
import {serviceUnits} from '../src/extract/service-units.js';
import {extractDataModel} from '../src/extract/data-model/extract.js';
import {repositoryConventions} from '../src/extract/library-models/repository-conventions.js';
import type {TreeReader} from '../src/extract/records.js';

function tree(files: Readonly<Record<string, string>>): TreeReader {
  return {
    paths: Object.keys(files).sort(),
    read(path: string): Uint8Array {
      const text = files[path];
      if (text === undefined) throw new Error(`${import.meta.path}:1: the fixture has no path ${path}`);
      return new TextEncoder().encode(text);
    },
  };
}

const namesOf = (files: Readonly<Record<string, string>>): string[] => serviceUnits(tree(files)).map((unit) => `${unit.source}:${unit.root || '.'}=${unit.name}`);

describe('a folded folder whose manifest is another project\'s', () => {
  for (const entry of repositoryConventions.foreignManifestFolders) {
    test(`${entry.id}: a manifest under ${entry.folder}/ declares no unit, and the same manifest elsewhere declares one`, () => {
      const manifest = entry.ecosystem === 'go' ? 'module example.test/inside\n' : '{"name":"inside"}';
      const file = entry.ecosystem === 'go' ? 'go.mod' : 'package.json';
      expect(namesOf({[`${entry.folder}/${file}`]: manifest})).toEqual([]);
      expect(namesOf({[`app/${file}`]: manifest})).toEqual([`manifest:app=inside`]);
    });
  }

  test('a build folder is no folded folder: its manifest declares a unit', () => {
    expect(namesOf({'build/package.json': '{"name":"tooling"}'})).toEqual(['manifest:build=tooling']);
  });
});

describe('a folder that declares a migration series', () => {
  for (const series of repositoryConventions.migrationSeries.filter((entry) => entry.nameFrom === 'file')) {
    test(`${series.id}: a .sql inside ${series.folder}/ is a migration of the unit that holds it`, async () => {
      const read = await extractDataModel(tree({
        'app/go.mod': 'module example.test/app\n',
        [`app/${series.folder}/0001_items${series.fileSuffix}`]: 'CREATE TABLE items (id text PRIMARY KEY);\n',
      }));
      expect(read.nodes.filter((node) => node.kind === 'code.migration').map((node) => node.key)).toEqual([`code.migration:app/0001_items${series.fileSuffix}`]);
      expect(read.nodes.filter((node) => node.kind === 'code.table').map((node) => node.key)).toEqual(['code.table:app/public.items']);
    });
  }

  for (const series of repositoryConventions.migrationSeries.filter((entry) => entry.nameFrom === 'parent' && entry.parent !== null && entry.fileName !== null)) {
    test(`${series.id}: ${series.parent}/${series.folder}/<name>/${series.fileName} is a migration named by its folder`, async () => {
      const at = `app/${series.parent}/${series.folder}/20260101000000_create/migration.sql`;
      const read = await extractDataModel(tree({
        'app/package.json': '{"name":"app"}',
        [at]: 'CREATE TABLE widgets (id text PRIMARY KEY);\n',
      }));
      expect(read.nodes.filter((node) => node.kind === 'code.migration').map((node) => node.key)).toEqual(['code.migration:app/20260101000000_create']);
      expect(read.nodes.filter((node) => node.kind === 'code.table').map((node) => node.key)).toEqual(['code.table:app/public.widgets']);
    });
  }

  test('a migration outside every unit declares its own database by its folder', async () => {
    const read = await extractDataModel(tree({'db/migrations/0001_items.sql': 'CREATE TABLE items (id text PRIMARY KEY);\n'}));
    expect(read.nodes.filter((node) => node.kind === 'code.database').map((node) => node.key)).toEqual(['code.database:db']);
    expect(read.nodes.filter((node) => node.kind === 'code.table').map((node) => node.key)).toEqual(['code.table:db/public.items']);
  });
});

describe('a Prisma schema\'s place', () => {
  for (const entry of repositoryConventions.prismaSchemas) {
    test(`${entry.id}: ${entry.folder}/${entry.fileName} declares the unit's tables`, async () => {
      const read = await extractDataModel(tree({
        'app/package.json': '{"name":"app","dependencies":{"@prisma/client":"5.0.0"}}',
        [`app/${entry.folder}/${entry.fileName}`]: 'model Widget {\n  id String @id\n  @@map("widgets")\n}\n',
      }));
      expect(read.nodes.filter((node) => node.kind === 'code.table').map((node) => node.key)).toEqual(['code.table:app/public.widgets']);
    });
  }
});

describe('a .sql file that declares tables is a schema, wherever it stands', () => {
  for (const entry of repositoryConventions.schemaScripts) {
    test(`${entry.id}: ${entry.declaresTables.join(', ')} declare the folder's schema, an INSERT does not`, async () => {
      const declaring = await extractDataModel(tree({[`db/001_items${entry.fileSuffix}`]: 'CREATE TABLE items (id text PRIMARY KEY);\n'}));
      expect(declaring.nodes.filter((node) => node.kind === 'code.table').map((node) => node.key)).toEqual(['code.table:db/public.items']);
      const seed = await extractDataModel(tree({
        [`db/001_items${entry.fileSuffix}`]: 'CREATE TABLE items (id text PRIMARY KEY);\n',
        [`db/002_seed${entry.fileSuffix}`]: 'INSERT INTO items (id) VALUES (\'one\');\n',
      }));
      // The seed is a script: it writes a row into the table the schema declares and declares nothing itself.
      expect(seed.nodes.filter((node) => node.kind === 'code.table').map((node) => node.key)).toEqual(['code.table:db/public.items']);
      expect(seed.edges.some((edge) => edge.type === 'code.writes-table' && edge.to === 'code.table:db/public.items')).toBe(true);
    });
  }
});

describe('a compose build context declares a unit where no manifest does', () => {
  for (const entry of repositoryConventions.composeServices.filter((service) => service.namesUnit)) {
    test(`${entry.id}: the service's build folder is its unit, and a manifest still wins`, () => {
      const compose = 'services:\n  api:\n    build: ./app\n';
      expect(namesOf({'docker-compose.yml': compose, 'app/main.go': 'package main\n'})).toEqual(['compose:app=api']);
      expect(namesOf({'docker-compose.yml': compose, 'app/main.go': 'package main\n', 'app/go.mod': 'module example.test/app\n'})).toEqual(['manifest:app=app']);
    });
  }
});
