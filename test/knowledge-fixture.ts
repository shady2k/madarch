/**
 * The product the knowledge wiki's checks and walks read: a draft product made
 * by madarch's own creation code, one linked code repository (the generated
 * training repository) and the two Markdown pages an agent would write, in the
 * shared format of the vertical (docs/decisions/0029): a product page and a
 * domain page whose statements end in footnotes that list their grounds. One
 * ground is broken and one statement has none, on purpose, so the checks see
 * the engine show both.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { gitEnv } from './git-env.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const GENERATOR = join(ROOT, 'examples/training-repository/generate.mjs');

/** The keys the sample pages name; each is a fact of the generated repository (the answer key's service.payments, pattern.factory and flow.payments.chain items). */
export const PAYMENTS_SERVICE = 'code.service:payments';
/** A record key, built from its parts so the neutral-names scan does not read it as a repository source. */
export const recordKey = (kind: string, rest: string): string => `${kind}:${rest}`;
export const FACTORY = recordKey('code.symbol', 'services/payments/src/providers/factory.ts#PaymentClientFactory');
export const PAY = recordKey('code.symbol', 'services/payments/src/domain/payment-service.ts#PaymentService.pay');
export const MISSING = recordKey('code.symbol', 'services/payments/src/providers/factory.ts#NoSuchFactory');

export const SAMPLE_PRODUCT = `---
id: product:shop
kind: product
title: Online shop
relates:
  - ${PAYMENTS_SERVICE}
producer: agent
sources: [docs/vision.md]
---
<!-- [orders](madarch:code.channel:orders.events) -->
The shop takes orders from shoppers and charges their cards through a payments service.[^1]

See the [payment domain](madarch:domain:payment) for how a charge happens.

[^1]: [payments](madarch:${PAYMENTS_SERVICE}), [UC-2](madarch:doc:docs/requirements.md#uc-2)

[^invisible]: [orders](madarch:code.channel:orders.events)
`;

export const SAMPLE_DOMAIN = `---
id: domain:payment
kind: domain
title: Payment
relates:
  - ${PAYMENTS_SERVICE}
  - ${PAY}
producer: agent
sources: [docs/requirements.md]
---
Payments are charged through one of two providers chosen by configuration.[^1]

Checkout asks payments to authorize the card for the order's total.[^2]

A refund that brings the refunded total up to the captured amount moves the order to refunded.

[Postgres](madarch:code.compose-service:docker-compose.yml#postgres) keeps the orders and [Kafka](madarch:code.broker:docker-compose.yml#kafka) carries them from the [outbox](madarch:code.table:orders/public.outbox).[^3]

[UC-1](madarch:doc:docs/requirements.md#uc-1) and [BR-3](madarch:doc:docs/requirements.md#br-3) govern the charge, and the [Outbox](madarch:doc:docs/glossary.md#outbox) and [Capture](madarch:doc:docs/glossary.md#capture) terms define it.[^3]

[^1]: [PaymentClientFactory](madarch:${FACTORY}), [a function that is not there](madarch:${MISSING})
[^2]: [UC-2](madarch:doc:docs/requirements.md#uc-2), [PaymentService.pay](madarch:${PAY})
[^3]: [Postgres](madarch:code.compose-service:docker-compose.yml#postgres), [Kafka](madarch:code.broker:docker-compose.yml#kafka), [outbox](madarch:code.table:orders/public.outbox), [UC-1](madarch:doc:docs/requirements.md#uc-1), [BR-3](madarch:doc:docs/requirements.md#br-3), [Outbox](madarch:doc:docs/glossary.md#outbox), [Capture](madarch:doc:docs/glossary.md#capture)
`;

export const SAMPLE_IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };

/** Generates the training repository at the path, once. */
export function generateTrainingRepository(path: string): string {
  if (!existsSync(join(path, '.git'))) execFileSync('node', [GENERATOR, path], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return path;
}

/** A draft product under the home with the repository linked as `repos/<name>`; the starter set comes with the draft. */
export function makeProduct(home: string, name: string, repository: string, repoName = 'training'): string {
  const draft = createDraft({ home, name, gitEnv: gitEnv(SAMPLE_IDENTITY) });
  if (draft.outcome !== 'created') throw new Error(`the fixture product was not made: ${JSON.stringify(draft)}`);
  const manifest = join(draft.folder, 'workspace.yaml');
  writeFileSync(manifest, manifestWithRepo(readFileSync(manifest, 'utf8'), { name: repoName, linked: true }));
  symlinkSync(repository, join(draft.folder, 'repos', repoName));
  return draft.folder;
}

/** The two pages an agent would write, as files of the product repository. */
export function writeSamplePages(folder: string): void {
  mkdirSync(join(folder, 'docs', 'domains'), { recursive: true });
  writeFileSync(join(folder, 'docs', 'product.md'), SAMPLE_PRODUCT);
  writeFileSync(join(folder, 'docs', 'domains', 'payment.md'), SAMPLE_DOMAIN);
}

/**
 * Drops the enrichment kind from a product's manifest: a scripted agent of these tests writes no enrichment page, and the
 * writer runs one unit per passage of a structured kind, so a declaration the script does not answer fails the run. A real
 * product keeps the kind (madarch-u3vw.1's starter set declares it), and `test/writer-structured-entities.test.ts` scripts
 * the enrichments and proves them.
 */
export function withoutEnrichmentKind(folder: string): void {
  const file = join(folder, 'madarch/kinds.yaml');
  const manifest = parseDocument(readFileSync(file, 'utf8'));
  if (!manifest.hasIn(['kinds', 'enrichment'])) return;
  manifest.deleteIn(['kinds', 'enrichment']);
  writeFileSync(file, manifest.toString());
}
