/**
 * The tests that start a fill their own way, and what brings each back (madarch-8bdc.2.5,
 * item 6h). This step's fill is `runFill` over `FILL_STEP_IDS`; a test whose case reads a
 * stage that is out of the list cannot pass until that stage's step comes, and it is named
 * here rather than given a private runner. The list only shrinks: a stage's step brings its
 * cases back, and the runner they will use is `runFill` like every other caller's.
 */
export interface SkippedFillSuite {
  /** The test file, from the repository root. */
  readonly file: string;
  /** The stage whose step brings the case back. */
  readonly brings: string;
  /** What the case reads that this step's fill does not publish. */
  readonly because: string;
}

const SKIPPED_FILL_SUITES: readonly SkippedFillSuite[] = [
  { file: 'test/fill-stages.test.ts', brings: 'snapshot, inventory, syntax, resolution, modules, documents', because: 'its cases assert the facts of the stages out of the list' },
  { file: 'test/fill-operations-training.test.ts', brings: 'operations, operations-links', because: 'it compares the operations reading against the extract driver' },
  { file: 'test/fill-operations-links.test.ts', brings: 'operations-links', because: 'it reads the variables and services the links stage publishes' },
  { file: 'test/fill-code-facts-stage.test.ts', brings: 'code-facts', because: 'it reads the fields and callables the code-facts stage publishes' },
  { file: 'test/fill-listener-ports.test.ts', brings: 'code-facts', because: 'it reads the ports the code-facts stage publishes' },
  { file: 'test/fill-state-machines-stage.test.ts', brings: 'state-machines', because: 'it reads the state machines that stage publishes' },
  { file: 'test/fill-data-model-stage.test.ts', brings: 'data-model and data-model-aggregate', because: 'it reads the databases and tables those stages assemble' },
  { file: 'test/fill-data-model-training.test.ts', brings: 'data-model', because: 'it compares the data model against the extract driver' },
  { file: 'test/fill-library-effects.test.ts', brings: 'library-effects', because: 'it reads the library effects of a file' },
  { file: 'test/fill-modules-stage.test.ts', brings: 'modules', because: 'it reads the module ranks and clusters' },
  { file: 'test/fill-syntax-stage.test.ts', brings: 'syntax', because: 'it reads the symbols and imports that stage publishes' },
  { file: 'test/fill-semantic-resolution-stage.test.ts', brings: 'semantic-resolution', because: 'it reads the resolved occurrences and calls' },
  { file: 'test/fill-service-membership.test.ts', brings: 'code-facts', because: 'it reads the service units that stage publishes' },
  { file: 'test/fill-static-heap.test.ts', brings: 'the static stages', because: 'it reads their memory bound over a fill' },
  { file: 'test/fill-code-facts-training.test.ts', brings: 'code-facts', because: 'it compares the code facts against the extract driver' },
  { file: 'test/fill-operations-fixture.test.ts', brings: 'operations', because: 'it reads the operations records of a folder' },
  { file: 'test/fill-impact.test.ts', brings: 'snapshot, inventory, syntax and the agent stages', because: 'its run reads the snapshot stage\'s commit nodes and the agent stages\' reruns' },
  { file: 'test/fill-resolution-graph.test.ts', brings: 'resolution and its static stages', because: 'it reads the calls, references and inheritance edges the resolution stage publishes' },
  // The wiki's pages are drawn from the temporal graph the static stages publish; this step's fill publishes the
  // tree and the history records, and the pages return with those stages' steps. The reader itself works: it opens
  // the store and reads its pins (test/fill-one-store.test.ts, test/wiki-readers.test.ts).
  { file: 'test/knowledge-home-page.test.ts', brings: 'the history and static stages that publish the temporal graph', because: 'its page blocks read the commits and files those stages publish' },
  { file: 'test/knowledge-diagrams.test.ts', brings: 'the static stages that publish the temporal graph', because: 'its diagrams are drawn from the graph\'s symbols, operations and tables' },
  { file: 'test/writer-journal.test.ts', brings: 'the static stages that publish the temporal graph', because: 'its journal is read per page the graph holds' },
  // madarch-8bdc.2.5, items 1 to 3: `madarch mcp` reads the store the one fill publishes, and this step's fill is
  // the tree and the history passes. The four mcp suites are not named here: their cases read the five tools of
  // this step from the store (and the seven tools' step-not-run answers), so they run. `test/wiki-fill-button-walk`
  // reads the repository pages this step publishes, so it runs too. A case that asked the seven tools for facts of
  // the temporal graph would be named here until those stages' steps come.
];

/**
 * Whether a test file starts a fill of a stage this step does not run. The file is
 * matched by the tail of its path, so a run from any folder names the same suite.
 */
export function skippedBecauseOutOfWorkflow(file: string): SkippedFillSuite | undefined {
  const normalized = file.split('\\').join('/');
  return SKIPPED_FILL_SUITES.find((entry) => normalized === entry.file || normalized.endsWith(`/${entry.file}`));
}
