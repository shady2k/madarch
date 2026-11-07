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

export const SKIPPED_FILL_SUITES: readonly SkippedFillSuite[] = [
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
];

/** Whether a test file starts a fill of a stage this step does not run. */
export function skippedBecauseOutOfWorkflow(file: string): SkippedFillSuite | undefined {
  return SKIPPED_FILL_SUITES.find((entry) => entry.file === file);
}
