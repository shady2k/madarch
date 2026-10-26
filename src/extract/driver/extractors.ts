/**
 * The extractors the driver runs (the brief's list): every tree extractor that
 * has landed under src/extract, and the history extractor, which reads the
 * repository itself. A new extractor is added here when it lands; the driver
 * needs no other change.
 */
import { CODE_PRODUCER, extractCodeWithFacts } from '../code/index.js';
import { extractContracts } from '../contracts/index.js';
import { extractDataModel } from '../data-model/extract.js';
import { extractHistory } from '../history/index.js';
import { extractOperations, OPERATIONS_PRODUCER } from '../operations/index.js';
import { extractFiles, FILES_PRODUCER } from './files.js';
import type { HistoryExtractor, TreeExtractor } from './index.js';
import { codeQueryDigest } from '../code/query.js';
import { libraryModelDigest } from '../library-models/validate.js';
import libraryModelSource from '../library-models/models.json' with { type: 'text' };
import { httpModelDigest } from '../library-models/http-models.js';
import { metricSemanticModelDigest } from '../library-models/metric-semantic-models.js';
import metricSemanticModelSource from '../library-models/metric-semantic-models.json' with { type: 'text' };
import httpModelSource from '../library-models/http-models.json' with { type: 'text' };

import { messagingModelDigest } from '../library-models/messaging-models.js';
import messagingModelSource from '../library-models/messaging-models.json' with { type: 'text' };
import { environmentModelDigest } from '../library-models/environment-models.js';
import environmentModelSource from '../library-models/environment-models.json' with { type: 'text' };
import { grpcDeadlineModelDigest } from '../library-models/grpc-deadline-models.js';
import grpcDeadlineModelSource from '../library-models/grpc-deadline-models.json' with { type: 'text' };
import { outboxModelDigest } from '../library-models/outbox-models.js';
import outboxModelSource from '../library-models/outbox-models.json' with { type: 'text' };
import { shellCommandModelDigest } from '../library-models/shell-command-models.js';
import shellCommandModelSource from '../library-models/shell-command-models.json' with { type: 'text' };

/** Every tree extractor, in the order the driver runs them per commit. */
const TREE_READERS = [
 {name:'extractFiles',version:2,extractor:extractFiles},
 {name:'extractCode',version:15,extractor:extractCodeWithFacts},
 {name:'extractOperations',version:16,extractor:extractOperations},
 {name:'extractContracts',version:15,extractor:extractContracts},
 {name:'extractDataModel',version:8,extractor:extractDataModel},
] as const;
export const TREE_EXTRACTORS: readonly TreeExtractor[] = TREE_READERS.map((entry)=>entry.extractor);

/** The history extractor, published once at the last commit under its own producer. */
export const HISTORY_EXTRACTOR: HistoryExtractor = (repository) => extractHistory({ repository: repository.path, snapshots: repository.snapshots });

/**
 * Node ownership: one preferred owning producer per kind. Cross-producer
 * relations publish last, so this order is not a dependency order. The tree lister owns files; the code extractor
 * (`code.extract.code`) owns symbols; the operations extractor owns services,
 * because it is the one that reads them from their manifests — without the
 * entry, the data model's `code.service:` edge opened a stub node of its own
 * and one service stood in the graph twice (madarch-m38l.16).
 */
export const OWNERS: Readonly<Record<string, string>> = { 'code.file': FILES_PRODUCER, 'code.symbol': CODE_PRODUCER, 'code.service': OPERATIONS_PRODUCER, 'code.channel': 'code.extract.contracts', 'code.dependency': OPERATIONS_PRODUCER };

/** The persistent index is rebuilt when any named reader's interpretation changes. */
export const EXTRACTOR_VERSIONS = [
 ...TREE_READERS.map(({name,version})=>({name,version})), {name:'extractHistory',version:1},
 {name:'code-structural-query-assets',version:1,contentDigest:codeQueryDigest()},
 {name:'code-parser-runtime:web-tree-sitter@0.25.10:tree-sitter-wasms@0.1.13',version:1},
 {name:'library-model-data',version:1,contentDigest:libraryModelDigest},
 {name:'http-model-data',version:1,contentDigest:httpModelDigest},
 {name:'metric-semantic-model-data',version:1,contentDigest:metricSemanticModelDigest},
 {name:'metric-semantic-model-source-bytes',version:1,contentDigest:codeQueryDigest([{path:'library-models/metric-semantic-models.json',source:metricSemanticModelSource as unknown as string}])},
 {name:'http-model-source-bytes',version:1,contentDigest:codeQueryDigest([{path:'library-models/http-models.json',source:httpModelSource as unknown as string}])},
 {name:'library-model-source-bytes',version:1,contentDigest:codeQueryDigest([{path:'library-models/models.json',source:libraryModelSource as unknown as string}])},
 {name:'messaging-model-data',version:1,contentDigest:messagingModelDigest},
 {name:'messaging-model-source-bytes',version:1,contentDigest:codeQueryDigest([{path:'library-models/messaging-models.json',source:messagingModelSource as unknown as string}])},
 {name:'environment-model-data',version:1,contentDigest:environmentModelDigest},
 {name:'environment-model-source-bytes',version:1,contentDigest:codeQueryDigest([{path:'library-models/environment-models.json',source:environmentModelSource as unknown as string}])},
 {name:'grpc-deadline-model-data',version:1,contentDigest:grpcDeadlineModelDigest},
 {name:'grpc-deadline-model-source-bytes',version:1,contentDigest:codeQueryDigest([{path:'library-models/grpc-deadline-models.json',source:grpcDeadlineModelSource as unknown as string}])},
 {name:'outbox-model-data',version:1,contentDigest:outboxModelDigest},
 {name:'outbox-model-source-bytes',version:1,contentDigest:codeQueryDigest([{path:'library-models/outbox-models.json',source:outboxModelSource as unknown as string}])},
 {name:'sql-parser-runtime:libpg-query@18.2.1',version:1},
 {name:'shell-command-model-data',version:1,contentDigest:shellCommandModelDigest},
 {name:'shell-command-model-source-bytes',version:1,contentDigest:codeQueryDigest([{path:'library-models/shell-command-models.json',source:shellCommandModelSource as unknown as string}])},
 {name:'driver-and-link-normalization',version:8},
] as const;
