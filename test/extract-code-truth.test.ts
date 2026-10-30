import { describe, expect, test } from 'bun:test';
import { extractCode } from '../src/extract/code/index.js';
import { fileKey, symbolKey, REL_CALLS, REL_CONTAINS, REL_IMPORTS, REL_OCCURRENCE, REL_READS, REL_REFERENCES, REL_USES_TYPE, REL_WRITES } from '../src/extract/code/keys.js';
import type { Extraction, ExtractedEdge, TreeReader } from '../src/extract/records.js';

const encoder = new TextEncoder();
function reader(files: Record<string, string>): TreeReader {
  return { paths: Object.keys(files).sort(), read(path) {
    const text = files[path];
    if (text === undefined) throw new Error(`missing fixture file ${path}`);
    return encoder.encode(text);
  } };
}
function edges(ex: Extraction, type: string, from: string, to: string): ExtractedEdge[] {
  return ex.edges.filter((edge) => edge.type === type && edge.from === from && edge.to === to);
}
function edge(ex: Extraction, type: string, from: string, to: string): ExtractedEdge {
  const found = edges(ex, type, from, to)[0];
  if (found === undefined) throw new Error(`missing ${type}: ${from} -> ${to}; found ${JSON.stringify(ex.edges.filter((item) => item.from === from))}`);
  return found;
}
const sym = (name: string): string => symbolKey('src/main.ts', name);

describe('madarch-m38l.20 code truth', () => {
  test('members-types-and-accesses: class and interface own their members, reads and writes name the actual field use', async () => {
    const source = `interface Named { name: string; show(): string }
class Cardnet implements Named {
  name = "card";
  show(): string { return this.name; }
  rename(): void {
    this.name = "changed";
    this.name += "!";
  }
}
function use(card: Cardnet): Named { return card; }
const label = new Cardnet().name;
`;
    const ex = await extractCode(reader({'src/main.ts': source}));
    edge(ex, REL_CONTAINS, sym('Cardnet'), sym('Cardnet.name'));
    edge(ex, REL_CONTAINS, sym('Cardnet'), sym('Cardnet.show'));
    edge(ex, REL_CONTAINS, sym('Named'), sym('Named.name'));
    edge(ex, REL_CONTAINS, sym('Named'), sym('Named.show'));
    expect(edge(ex, REL_READS, sym('Cardnet.show'), sym('Cardnet.name')).span?.lineStart).toBe(4);
    expect(edge(ex, REL_WRITES, sym('Cardnet.rename'), sym('Cardnet.name')).span?.lineStart).toBe(6);
    expect(edge(ex, REL_READS, sym('Cardnet.rename'), sym('Cardnet.name')).span?.lineStart).toBe(7);
    edge(ex, REL_READS, fileKey('src/main.ts'), sym('Cardnet.name'));
    edge(ex, REL_USES_TYPE, sym('use'), sym('Cardnet'));
    edge(ex, REL_USES_TYPE, sym('use'), sym('Named'));
    edge(ex, REL_REFERENCES, sym('use'), sym('Cardnet'));
    edge(ex, REL_REFERENCES, sym('use'), sym('Named'));
    const typeOccurrence = ex.edges.filter((item) => item.type === REL_OCCURRENCE && item.from === sym('use') && item.to === sym('Cardnet'));
    expect(typeOccurrence).toHaveLength(1);
    expect(typeOccurrence[0]!.properties.use).toBe('type');
    expect(edges(ex, REL_CALLS, sym('use'), sym('Cardnet'))).toEqual([]);
    expect(edges(ex, REL_READS, sym('use'), sym('Cardnet'))).toEqual([]);
    const write = ex.edges.find((item) => item.type === REL_OCCURRENCE && item.from === sym('Cardnet.rename') && item.to === sym('Cardnet.name') && item.span?.lineStart === 6);
    expect(write?.properties.roles).toEqual(['write-access']);
    expect(new TextDecoder().decode(encoder.encode(source).slice(write?.span?.byteStart, write?.span?.byteEnd))).toBe('name');
  });

  test('constructors-and-callback-references: explicit and implicit construction are calls, callback arguments and maps are references', async () => {
    const source = `class Explicit { constructor() {} }
class Implicit {}
function errorHandler() {}
function direct() {}
function setup(app: any) {
  new Explicit();
  new Implicit();
  app.use(errorHandler);
  const handlers = { failure: errorHandler };
  direct();
}
`;
    const ex = await extractCode(reader({'src/main.ts': source}));
    edge(ex, REL_CONTAINS, sym('Explicit'), sym('Explicit.constructor'));
    expect(edge(ex, REL_CALLS, sym('setup'), sym('Explicit.constructor')).span?.lineStart).toBe(6);
    const classReference = edge(ex, REL_REFERENCES, sym('setup'), sym('Explicit'));
    expect(classReference.span).toEqual(edge(ex, REL_CALLS, sym('setup'), sym('Explicit.constructor')).span);
    expect(classReference.properties.count).toBe(1);
    expect(edges(ex, REL_CALLS, sym('setup'), sym('Explicit'))).toEqual([]);
    const construction = ex.edges.filter((item) => item.type === REL_OCCURRENCE && item.from === sym('setup') && item.span?.lineStart === 6);
    expect(construction.map((item) => [item.to, item.properties.use])).toEqual([[sym('Explicit'), 'reference'], [sym('Explicit.constructor'), 'call']]);
    const implicitCall = edge(ex, REL_CALLS, sym('setup'), sym('Implicit'));
    const implicitReference = edge(ex, REL_REFERENCES, sym('setup'), sym('Implicit'));
    expect(implicitReference.span?.lineStart).toBe(7);
    expect(implicitReference.span).toEqual(implicitCall.span);
    expect(implicitReference.properties.count).toBe(1);
    expect(ex.edges.filter((item) => item.type === REL_OCCURRENCE && item.from === sym('setup') && item.span?.lineStart === 7)
      .map((item) => [item.to, item.properties.use])).toEqual([[sym('Implicit'), 'call']]);
    expect(ex.nodes.some((item) => item.key === sym('Implicit.constructor'))).toBe(false);
    expect(ex.edges.some((item) => item.to === sym('Implicit.constructor'))).toBe(false);
    expect(edge(ex, REL_REFERENCES, sym('setup'), sym('errorHandler')).properties.count).toBe(2);
    expect(edges(ex, REL_CALLS, sym('setup'), sym('errorHandler'))).toEqual([]);
    edge(ex, REL_CALLS, sym('setup'), sym('direct'));
  });

  test('scope-aware-members: an unrelated parameter and block-local value never resolve to a same-named repository type', async () => {
    const source = `class Cardnet { name = "card"; }
function use(card: Cardnet) {
  card.name;
  { const card = { name: "local" }; card.name; }
  card.name;
}
function unrelated(card: any) { card.name; }
`;
    const ex = await extractCode(reader({'src/main.ts': source, 'src/other.ts': 'export class Cardnet { name = "other"; }'}));
    expect(edge(ex, REL_READS, sym('use'), sym('Cardnet.name')).properties.count).toBe(2);
    expect(edges(ex, REL_READS, sym('unrelated'), sym('Cardnet.name'))).toEqual([]);
    expect(ex.edges.filter((item) => item.type === REL_READS && item.to === symbolKey('src/other.ts', 'Cardnet.name'))).toEqual([]);
  });

  test('generic-type-parameters: a generic parameter never names an unrelated same-named class', async () => {
    const ex = await extractCode(reader({'src/main.ts': 'class Item { name = "outer"; }\nfunction generic<Item>(value: Item) { return value; }\n'}));
    expect(edges(ex, REL_USES_TYPE, sym('generic'), sym('Item'))).toEqual([]);
    expect(edges(ex, REL_REFERENCES, sym('generic'), sym('Item'))).toEqual([]);
  });

  test('go-members-types-and-accesses: cross-file methods belong to their struct, qualified uses and field writes keep use spans', async () => {
    const ex = await extractCode(reader({
      'go.mod': 'module example.test/demo\n\ngo 1.23\n',
      'model/card.go': 'package model\ntype Card struct { Name string }\n',
      'model/change.go': 'package model\nfunc (c *Card) Rename() { c.Name = "next"; c.Name += "!" }\n',
      'main.go': 'package main\nimport "example.test/demo/model"\nfunc use(c model.Card) string { return c.Name }\n',
    }));
    const type = symbolKey('model/card.go', 'Card');
    const field = symbolKey('model/card.go', 'Card.Name');
    const method = symbolKey('model/change.go', 'Card.Rename');
    edge(ex, REL_CONTAINS, type, field);
    edge(ex, REL_CONTAINS, type, method);
    edge(ex, REL_WRITES, method, field);
    edge(ex, REL_READS, method, field);
    edge(ex, REL_READS, symbolKey('main.go', 'use'), field);
    edge(ex, REL_USES_TYPE, symbolKey('main.go', 'use'), type);
  });

  test('constant-and-property-reads: named imports and namespace properties resolve without changing callbacks into calls', async () => {
    const ex = await extractCode(reader({
      'src/values.ts': 'export const LIMIT = 3;\nexport interface Options { limit: number }\n',
      'src/main.ts': 'import { LIMIT, Options } from "./values.js";\nimport * as values from "./values.js";\nfunction use(options: Options) { return LIMIT + values.LIMIT + options.limit; }\n',
    }));
    expect(edge(ex, REL_READS, sym('use'), symbolKey('src/values.ts', 'LIMIT')).properties.count).toBe(2);
    edge(ex, REL_READS, sym('use'), symbolKey('src/values.ts', 'Options.limit'));
  });

  test('internal-external-and-standard-imports: importing manifest scope and Go module prefixes select owning dependency identities', async () => {
    const ex = await extractCode(reader({
      'package.json': JSON.stringify({ dependencies: { express: '^1.0.0' } }),
      'src/main.ts': 'import express from "express";\nimport fs from "node:fs";\nimport "undeclared-package";\nimport { run } from "./run.js";\n',
      'src/run.ts': 'export function run() {}',
      'nested/package.json': JSON.stringify({ dependencies: { express: '^2.0.0' } }),
      'nested/main.ts': 'import express from "express";',
      'go.mod': 'module example.test/demo\n\ngo 1.23\n\nrequire example.test/library v1.2.3\n',
      'main.go': 'package main\nimport (\n "fmt"\n "example.test/library/sub"\n "missing.test/client"\n)\n',
    }));
    expect(edge(ex, REL_IMPORTS, fileKey('src/main.ts'), 'code.dependency:package.json#express').properties.version).toBe('^1.0.0');
    expect(edge(ex, REL_IMPORTS, fileKey('nested/main.ts'), 'code.dependency:nested/package.json#express').properties.version).toBe('^2.0.0');
    edge(ex, REL_IMPORTS, fileKey('src/main.ts'), fileKey('src/run.ts'));
    expect(edge(ex, REL_IMPORTS, fileKey('main.go'), 'code.dependency:go.mod#example.test/library').properties.version).toBe('v1.2.3');
    for (const [file, ecosystem, specifier, standard] of [
      ['src/main.ts', 'node', 'node:fs', true],
      ['src/main.ts', 'node', 'undeclared-package', false],
      ['main.go', 'go', 'fmt', true],
      ['main.go', 'go', 'missing.test/client', false],
    ] as const) {
      const target = `code.package:import/${ecosystem}/${specifier}`;
      edge(ex, REL_IMPORTS, fileKey(file), target);
      const node = ex.nodes.find((item) => item.key === target);
      expect(node?.properties.standardLibrary).toBe(standard);
      expect(node?.properties.versionStatus).toBe(standard ? 'not-applicable' : 'not-declared');
      expect(node?.properties.version).toBeUndefined();
      expect(node?.span?.path).toBe(file);
    }
    expect(ex.nodes.some((item) => item.kind === 'code.dependency')).toBe(false);
    expect(await extractCode(reader({'src/main.ts': 'import "node:fs";'}))).toEqual(await extractCode(reader({'src/main.ts': 'import "node:fs";'})));
  });

  test('a field initializer is the field value, read from the syntax tree', async () => {
    const source = `class Ledger {
  readonly currency: string = "EUR";
  private balance = 0;
  limit: number;
  enabled = true;
  constructor(private readonly owner: string = "shop") {}
  total(): number { return this.balance; }
}
`;
    const ex = await extractCode(reader({'src/main.ts': source}));
    const field = (name: string) => {
      const node = ex.nodes.find((item) => item.key === sym(`Ledger.${name}`));
      if (node === undefined) throw new Error(`missing field Ledger.${name}; found ${JSON.stringify(ex.nodes.map((item) => item.key))}`);
      return node;
    };
    // The value is what the file writes after the `=`: a string literal without its quotes, a number, a boolean.
    expect(field('currency').properties.value).toBe('EUR');
    expect(field('balance').properties.value).toBe('0');
    expect(field('enabled').properties.value).toBe('true');
    // A field the file declares and never initializes has no value, and a method is not a field.
    expect(field('limit').properties.value).toBeUndefined();
    expect(field('total').properties.value).toBeUndefined();
    // A constructor's property parameter (`private readonly owner: string = "shop"`) is a field too.
    expect(field('owner').properties.value).toBe('shop');
  });

  test('unicode-use-spans: field evidence uses UTF-8 byte offsets at the identifier', async () => {
    const source = 'class Cardnet { name = "карта"; read() { return this.name; } }';
    const ex = await extractCode(reader({'src/main.ts': source}));
    const span = edge(ex, REL_READS, sym('Cardnet.read'), sym('Cardnet.name')).span!;
    expect(new TextDecoder().decode(encoder.encode(source).slice(span.byteStart, span.byteEnd))).toBe('name');
  });

  test('missing-internal-import: an unresolved repository path is a located gap, not an external package guess', async () => {
    const ex = await extractCode(reader({'src/main.ts': 'import { missing } from "./absent.js";'}));
    expect(ex.gaps.some((gap) => gap.path === 'src/main.ts' && gap.reason.includes('line 1') && gap.reason.includes('./absent.js'))).toBe(true);
    expect(ex.nodes.filter((node) => node.key.includes('import/'))).toEqual([]);
    const go = await extractCode(reader({'go.mod': 'module example.test/demo\n', 'main.go': 'package main\nimport "example.test/demo/absent"\n'}));
    expect(go.gaps.some((gap) => gap.path === 'main.go' && gap.reason.includes('line 2') && gap.reason.includes('example.test/demo/absent'))).toBe(true);
    expect(go.nodes.filter((node) => node.key.includes('import/'))).toEqual([]);
  });
});


test('external import identity aggregates distinct real sites, not alias bindings, with exact evidence',async()=>{
 const source=`import first, {one as renamed,two} from 'some-package/one';\nimport {three} from 'some-package/two';\nimport second from 'some-package/one';\nimport {randomUUID as uuid} from 'node:crypto';\nexport const value=[first,renamed,two,three,second,uuid];\n`;
 const files={'src/main.ts':source,'package.json':JSON.stringify({name:'example',dependencies:{'some-package':'1.0.0'}}),'go.mod':'module example.test/demo\ngo 1.23\n','main.go':'package main\nimport alias "fmt"\nfunc main(){alias.Println("x")}\n'};const ex=await extractCode(reader(files));
 const rows=ex.edges.filter((item)=>item.type===REL_IMPORTS);expect(rows.every((item)=>item.discriminator==='')).toBe(true);
 const dependency=rows.find((item)=>item.to==='code.dependency:package.json#some-package')!;expect(dependency.properties.count).toBe(3);expect(dependency.properties.specifiers).toEqual(['some-package/one','some-package/two']);
 const readings=dependency.properties.importReadings as {specifier:string;span:{byteStart:number;byteEnd:number;lineStart:number}}[];expect(readings.map((item)=>item.span.lineStart)).toEqual([1,2,3]);for(const item of readings)expect(new TextDecoder().decode(encoder.encode(source).subarray(item.span.byteStart,item.span.byteEnd))).toBe(`'${item.specifier}'`);
 expect(rows.find((item)=>item.properties.specifier==='node:crypto')?.properties.count).toBe(1);expect(rows.find((item)=>item.properties.specifier==='fmt')?.properties.standardLibrary).toBe(true);
});

test('registered inline callback keeps its byte identity but has a readable label and owns its call', async () => {
  const text = 'import express from "express"; function target() {} export function routes() {const app=express(); app.post("/pay",()=>target());}';
  const ex = await extractCode(reader({'main.ts':text}));
  const start = encoder.encode(text.slice(0,text.indexOf('()=>'))).length;
  const key = symbolKey('main.ts', `routes.callback@1:${start}`);
  const callback = ex.nodes.filter((node)=>node.properties.inline===true);
  expect(callback).toHaveLength(1);
  expect(callback[0]).toMatchObject({key,label:'routes callback (line 1)',span:{path:'main.ts',byteStart:start,lineStart:1,lineEnd:1}});
  expect(edges(ex,REL_CALLS,key,symbolKey('main.ts','target'))).toHaveLength(1);
  expect(edges(ex,REL_CALLS,symbolKey('main.ts','routes'),symbolKey('main.ts','target'))).toEqual([]);
});
