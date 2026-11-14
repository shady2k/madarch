# Imports: which file imports which, and the packages it names

Change: imports
Base: 1fc72ca3cb13b9612cf77f85f29486d75e4cd1e7
Tasks: madarch-o0eq.6, madarch-64o5.73
Kind: behavior

## Intent
The graph states the imports between the files it holds: which file imports which file of its repository, and which
package each file names. Before this change the native code extractor that stated imports was removed, so a reader could
not ask who imports a module or what a module imports.

After it, an imports plugin reads the TypeScript and JavaScript file vertices and their content from the graph — it
never walks a repository — parses them with `@babel/parser`, and states `code.imports` between two files and
`code.imports-package` from a file to a `code.package` entity keyed by ecosystem and name. Every edge repeats, told apart
by the line and column of the import, and carries the specifier as written, the form (static, type, dynamic, require,
re-export) and the imported names. A specifier resolves the way the repository's own resolution reads it: relative paths
with the TypeScript and ESM extension rules, index files, a folder's package entry, and the tsconfig nearest the file
with its baseUrl and paths. A relative specifier no file answers, and a file the parser refuses or the graph does not
answer, are problems with their places: the run states the rest and the graph records the dangling ends as unresolved
references. The catalogue declares the two edge kinds with the `imports` capability, and `code.package` becomes the
imported package.

The fill plans a plugin's turn after the producers of the kinds the plugin reads. A kind's `derives-from` names what the
concept rests on, never the source one producer reads; the plugin's `reads` is that source, and the selected set follows
both, so a plugin reading `code.file` runs after the files producer without the output kind declaring the files.

## Out of scope
Languages other than TypeScript and JavaScript; import forms beyond the declarations, `export … from`, `require()`, a
dynamic `import()` with a constant specifier and `import('x').T`; package versions, dependency manifests and lockfiles;
the code structure kinds (symbols, calls, modules, cycles); the page layer and its templates, which the graph-api change
removed; and an agent pass over the imports.

## Where it is seen

Kind: request
Place: POST /graphql and madarch mcp graph_query

1. A client sends `POST /graphql` a query for a `code.file` entity and reads its `codeImports` and `codeImportsOf`
   connections, each edge carrying its `discriminator`, `place`, `specifier`, `form`, `names` and opinions.
2. A client reads a `code.package` entity by its key (ecosystem and name) and follows `codeImportsPackageOf` back to
   every file that imports it.
3. An agent calls `graph_schema` in `madarch mcp`, composes the same query, and runs it through `graph_query`.

## Blocking questions
None.

## Preserved contracts
None.

## Coverage
- code-records/language: test
- code-records/class: test
- code-records/periods: test
- code-records/counts: test
- code-records/imports: test
- code-records/resolution: test
- code-records/problems: test
- code-records/order: test
- code-records/schema: test
