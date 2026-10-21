
/**
 * The history extractor (src/extract/history) against the training
 * repository's answer key, madarch-o0eq.4. The repository is generated into a
 * temporary folder by the fixture's own generator; every expected value below
 * comes from the key (answer-key.json: plantedCounts, snapshots, the items'
 * statements, locations and checks), never from the extractor's own output.
 *
 * Areas: history, temporal, hotspot, change-coupling, rename, date-anomaly,
 * provider-authorship, large-file.
 */
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {byCodePoint} from '../src/model/order.js';
// @ts-expect-error the plan is plain JavaScript
import {COMMITS as PLAN, SNAPSHOTS as PLAN_SNAPSHOTS} from '../examples/training-repository/history.mjs';
import {extractHistory} from '../src/extract/history/index.js';
import type {ExtractedEdge, ExtractedNode, Extraction} from '../src/extract/records.js';

const root = path.dirname(new URL(import.meta.url).pathname);
const generator = path.join(root, '../examples/training-repository/generate.mjs');
const key = JSON.parse(await Bun.file(path.join(root, '../examples/training-repository/answer-key.json')).text());

const AREAS = /^(history|temporal|hotspot|change-coupling|rename|date-anomaly|provider-authorship|large-file)(\.|$)/u;
const MY_ITEMS = key.items.filter((item: {id: string; evidenceClass: string}) => AREAS.test(item.id) && ['code-fact', 'history-fact'].includes(item.evidenceClass));

type PlanCommit = {id?: string; message: string};
const plan = PLAN as PlanCommit[];
/** The subject the plan gives the commit whose id the key's snapshots name. */
const subjectOf = (id: string): string => {
  const entry = plan.find((c) => c.id === id);
  if (entry === undefined) throw new Error(`history.mjs has no commit ${id}`);
  return entry.message.split('\n')[0];
};

// ---- the fixture -----------------------------------------------------------

let repo: string;
let extraction: Extraction;

beforeAll(async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'madarch-extract-history-'));
  repo = path.join(tmp, 'training');
  execFileSync('node', [generator, repo], {cwd: root, stdio: 'pipe'});
  // The snapshot pins are the key's own map (input to the read, not an
  // expectation): the same records must come out wherever the key says the
  // snapshots stand.
  extraction = await extractHistory({repository: repo, snapshots: key.snapshots});
}, 180_000);
afterAll(async () => {
  if (repo !== undefined) await rm(path.dirname(repo), {recursive: true, force: true});
});

// ---- reading the extraction ------------------------------------------------

const node = (key_: string): ExtractedNode => {
  const hit = extraction.nodes.find((n) => n.key === key_);
  if (hit === undefined) throw new Error(`the extraction holds no node ${key_}`);
  return hit;
};
const maybeNode = (key_: string): ExtractedNode | undefined => extraction.nodes.find((n) => n.key === key_);
const edgesOf = (type: string): ExtractedEdge[] => extraction.edges.filter((e) => e.type === type);
const commitsOfKind = (): ExtractedNode[] => extraction.nodes.filter((n) => n.kind === 'code.commit');
const commitBySubject = (subject: string): ExtractedNode => {
  const hits = commitsOfKind().filter((n) => n.properties.subject === subject);
  if (hits.length !== 1) throw new Error(`${hits.length} commit nodes carry the subject ${JSON.stringify(subject)}`);
  return hits[0];
};
const fileNode = (p: string): ExtractedNode => node(`code.file:${p}`);
const heldAt = (snapshot: string, p: string): ExtractedEdge | undefined =>
  edgesOf('code.held').find((e) => e.from === `code.snapshot:${snapshot}` && e.to === `code.file:${p}`);
/** The content the extraction says a path holds at a snapshot, read from the repository the extraction names. */
const contentAt = (snapshot: string, p: string): string => {
  const edge = heldAt(snapshot, p);
  if (edge === undefined) throw new Error(`no code.held edge for ${p} at ${snapshot}`);
  const blob = edge.properties.blob;
  if (typeof blob !== 'string') throw new Error(`the code.held edge of ${p} at ${snapshot} carries no blob`);
  return execFileSync('git', ['-C', repo, 'cat-file', 'blob', blob], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
};

/** An instant plus one microsecond, as the extractor writes effective times. */
const plusMicro = (iso: string): string => {
  const m = /^(.+T)(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/u.exec(iso);
  if (m === null) throw new Error(`no instant: ${iso}`);
  const micros = ((Number(m[2]) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1_000_000 + Number((m[5] ?? '').padEnd(6, '0') || 0) + 1;
  const at = new Date(Math.floor(micros / 1_000_000) * 1000);
  const fraction = String(micros % 1_000_000).padStart(6, '0');
  return `${at.toISOString().slice(0, 19)}.${fraction}Z`;
};

// ---- the cases -------------------------------------------------------------

describe('the history extractor against the answer key', () => {
  test('every item of the areas has a named case below', () => {
    const ids = MY_ITEMS.map((item: {id: string}) => item.id).sort(byCodePoint);
    expect(ids, 'the areas of madarch-o0eq.4').toEqual([
      'change-coupling', 'date-anomaly', 'history.feature-branch', 'history.size', 'hotspot',
      'large-file', 'provider-authorship', 'rename.identity', 'temporal.checkout-without-payment-at-may',
      'temporal.discount-fixed-at-june', 'temporal.float-tax-at-aug', 'temporal.no-grpc-at-june',
      'temporal.no-retention-at-aug', 'temporal.outbox-at-june', 'temporal.statuses-at-june',
    ]);
  });

  // rename.identity: "services/orders/src/order.go was moved to
  // services/orders/internal/domain/order.go with its content unchanged; the
  // wiki must show one file with one history, not a deletion and a new file."
  test('rename.identity: the move is one identity-keeping edge and the history continues', () => {
    const renames = edgesOf('code.renamed-to');
    expect(renames).toHaveLength(1);
    const [rename] = renames;
    expect(rename.from).toBe('code.file:services/orders/src/order.go');
    expect(rename.to).toBe('code.file:services/orders/internal/domain/order.go');
    expect(rename.properties.similarity, 'R100: the content is kept').toBe(1);
    // At the May snapshot the file stands at the old path; at the end it stands
    // at the new one, and the old path is gone.
    expect(heldAt('snapshot-2026-05-01', 'services/orders/src/order.go')).toBeDefined();
    expect(heldAt('snapshot-2026-05-01', 'services/orders/internal/domain/order.go')).toBeUndefined();
    expect(heldAt('snapshot-final', 'services/orders/internal/domain/order.go')).toBeDefined();
    expect(heldAt('snapshot-final', 'services/orders/src/order.go')).toBeUndefined();
    // The May content is the order aggregate, as the key's check says.
    expect(contentAt('snapshot-2026-05-01', 'services/orders/src/order.go')).toContain('package domain');
    // One history: the surviving node counts the commits of both paths, and
    // commits touch the new path after the move.
    const move = commitBySubject('Move the order aggregate under internal/domain');
    const surviving = fileNode('services/orders/internal/domain/order.go');
    expect(typeof surviving.properties.commitCount).toBe('number');
    const stamp = (key_: string) => `${String(node(key_).properties.effectiveAt)}\u0000${key_}`;
    const after = edgesOf('code.touched')
      .filter((e) => e.to === surviving.key && stamp(e.from) > stamp(move.key));
    expect(after.length, 'history continues after the move').toBeGreaterThan(0);
  });

  // temporal.discount-fixed-at-june: "At snapshot-2026-06-01 orders applied a
  // fixed 10% discount to every order; the caller-supplied percentage arrived
  // on 2026-06-23."
  test('temporal.discount-fixed-at-june: the fixed 10% discount holds at June and changes later', () => {
    const p = 'services/orders/internal/application/order_service.go';
    const june = contentAt('snapshot-2026-06-01', p);
    expect(june, 'the anchor of the key at that date').toContain('pricing.Discount(total, 10)');
    expect(june).not.toBe(contentAt('snapshot-final', p));
    // Changed later: a commit dated 2026-06-23 touches the file after the snapshot.
    const later = edgesOf('code.touched').filter((e) => e.to === `code.file:${p}`)
      .map((e) => node(e.from))
      .filter((c) => String(c.properties.committedAt).startsWith('2026-06-23'));
    expect(later.length, 'the caller-supplied percentage arrived on 2026-06-23').toBeGreaterThan(0);
  });

  // temporal.no-grpc-at-june: "At snapshot-2026-06-01 payments had no gRPC
  // server and checkout had no payments client; the proto contract and both
  // sides arrived on 2026-06-11 and 2026-06-12."
  test('temporal.no-grpc-at-june: no gRPC server, proto or payments client at June', () => {
    for (const p of ['services/payments/src/grpc/server.ts', 'contracts/proto/payments.proto', 'services/checkout/src/payments-client.ts']) {
      expect(heldAt('snapshot-2026-06-01', p), `${p} at snapshot-2026-06-01`).toBeUndefined();
      expect(heldAt('snapshot-final', p), `${p} at the end`).toBeDefined();
    }
  });

  // temporal.outbox-at-june: "At snapshot-2026-06-01 the outbox, its writer and
  // its relay already existed (relay without row locking); payments published
  // nothing yet."
  test('temporal.outbox-at-june: the relay is there at June, the payment publishers are not', () => {
    const relay = contentAt('snapshot-2026-06-01', 'services/orders/internal/relay/relay.go');
    expect(relay).toContain('type Relay struct');
    expect(relay, 'relay without row locking').not.toContain('SKIP LOCKED');
    expect(heldAt('snapshot-2026-06-01', 'services/payments/src/events/publishers.ts')).toBeUndefined();
    expect(heldAt('snapshot-final', 'services/payments/src/events/publishers.ts')).toBeDefined();
    const adr = contentAt('snapshot-2026-06-01', 'docs/adr/0002-outbox.md');
    expect(adr, 'the key anchors the accepted ADR').toContain('accepted, 2026-05-28');
  });

  // temporal.no-retention-at-aug: "At snapshot-2026-08-15 orders had paging but
  // no expiry: there was no retention job and no ExpiryDays."
  test('temporal.no-retention-at-aug: no retention job and an older order.go at August', () => {
    expect(heldAt('snapshot-2026-08-15', 'services/orders/cmd/orders/retention.go')).toBeUndefined();
    expect(heldAt('snapshot-final', 'services/orders/cmd/orders/retention.go')).toBeDefined();
    const p = 'services/orders/internal/domain/order.go';
    expect(contentAt('snapshot-2026-08-15', p)).not.toBe(contentAt('snapshot-final', p));
    expect(contentAt('snapshot-2026-08-15', p), 'no ExpiryDays then').not.toContain('ExpiryDays');
  });

  // temporal.float-tax-at-aug: "At snapshot-2026-08-15 tax was computed with a
  // floating-point TaxRate of 0.08; basis points arrived on 2026-08-24."
  test('temporal.float-tax-at-aug: the float 0.08 rate holds at August and the file changes later', () => {
    const p = 'services/orders/internal/pricing/tax.go';
    expect(contentAt('snapshot-2026-08-15', p), 'the anchor of the key').toContain('const TaxRate = 0.08');
    expect(contentAt('snapshot-2026-08-15', p)).not.toBe(contentAt('snapshot-final', p));
    const later = edgesOf('code.touched').filter((e) => e.to === `code.file:${p}`)
      .map((e) => node(e.from))
      .filter((c) => String(c.properties.committedAt).startsWith('2026-08-24'));
    expect(later.length, 'basis points arrived on 2026-08-24').toBeGreaterThan(0);
  });

  // temporal.statuses-at-june: "At snapshot-2026-06-01 an order had four
  // statuses (pending_payment, confirmed, cancelled, shipped); refunded was
  // added on 2026-07-09."
  test('temporal.statuses-at-june: four statuses at June and none of them refunded', () => {
    const p = 'services/orders/internal/domain/order.go';
    const june = contentAt('snapshot-2026-06-01', p);
    expect(june, 'the anchor of the key').toContain('Shipped Status = "shipped"');
    for (const status of ['pending_payment', 'confirmed', 'cancelled', 'shipped']) expect(june, status).toContain(status);
    expect(june, 'no refunded at June').not.toContain('refunded');
    expect(june).not.toBe(contentAt('snapshot-final', p));
  });

  // temporal.checkout-without-payment-at-may: "At snapshot-2026-05-01 checkout
  // only placed orders (outcome "placed"); it asked for no payment."
  test('temporal.checkout-without-payment-at-may: checkout places orders and asks for no payment', () => {
    const p = 'services/checkout/src/checkout-service.ts';
    const may = contentAt('snapshot-2026-05-01', p);
    expect(may, 'the anchor of the key').toContain("outcome: 'placed'");
    expect(may, 'it asked for no payment').not.toContain('PaymentsClient');
    expect(heldAt('snapshot-2026-05-01', 'services/checkout/src/payments-client.ts')).toBeUndefined();
  });

  // history.feature-branch: "One feature branch, feature/checkout-observability
  // (two commits: request ids through checkout and in the order service), was
  // merged into main by a merge commit on 2026-08-04; on the first-parent line
  // of main its work appears at the merge."
  test('history.feature-branch: two branch commits valid at the 2026-08-04 merge', () => {
    const merges = commitsOfKind().filter((n) => n.properties.merge === true);
    expect(merges, key.plantedCounts.mergeCommits).toHaveLength(1);
    const merge = merges[0];
    expect(merge.properties.mergedBranch, 'the branch name').toBe('feature/checkout-observability');
    expect(merge.properties.committedAt, 'the merge date').toBe('2026-08-04T10:00:00Z');
    const branch = commitsOfKind().filter((n) => n.properties.onFirstParent === false);
    expect(branch, 'two commits').toHaveLength(2);
    for (const commit of branch) {
      expect(commit.properties.effectiveAt, 'branch changes are valid at the merge').toBe(merge.properties.effectiveAt);
      expect(String(commit.properties.committedAt), 'their own times are kept raw').not.toBe(merge.properties.effectiveAt);
    }
    // First-parent view: 70 commits on the line, the branch's two not among them.
    const onLine = commitsOfKind().filter((n) => n.properties.onFirstParent === true);
    expect(onLine).toHaveLength(key.plantedCounts.firstParentCommits);
    expect(commitsOfKind()).toHaveLength(key.plantedCounts.commits);
    // The branch's work carries the request id into the order service.
    expect(plan.find((c) => c.id === 'request-id-log')).toBeDefined();
    expect(branch.map((c) => c.properties.subject).join(' ')).toContain('request id');
  });

  // history.size: "The history has 72 commits (70 on the first-parent line,
  // 1 merge) by three authors, Rin Tanaka (payments), Avery Quinn (orders,
  // infrastructure) and Sam Okafor (checkout, promotions, documents), from
  // 2026-04-13 to 2026-10-12."
  test('history.size: 72 commits, 70 first-parent, one merge, three authors, six months', () => {
    expect(commitsOfKind()).toHaveLength(key.plantedCounts.commits);
    expect(commitsOfKind().filter((n) => n.properties.onFirstParent === true)).toHaveLength(key.plantedCounts.firstParentCommits);
    expect(commitsOfKind().filter((n) => n.properties.merge === true)).toHaveLength(key.plantedCounts.mergeCommits);
    const authors = extraction.nodes.filter((n) => n.kind === 'code.author').map((n) => n.label).sort(byCodePoint);
    expect(authors).toEqual(['Avery Quinn', 'Rin Tanaka', 'Sam Okafor']);
    const times = commitsOfKind().map((n) => String(n.properties.committedAt)).sort(byCodePoint);
    expect(times[0].startsWith('2026-04-13'), `oldest ${times[0]}`).toBe(true);
    expect(times[times.length - 1].startsWith('2026-10-12'), `newest ${times[times.length - 1]}`).toBe(true);
  });

  // hotspot: "order_service.go is the change hotspot: 28 of the 71 non-merge
  // commits change it (merge commits do not count; the feature branch's commit
  // does)."
  test('hotspot: order_service.go is changed by 28 non-merge commits, the most of any file', () => {
    const p = 'services/orders/internal/application/order_service.go';
    expect(fileNode(p).properties.commitCount, key.plantedCounts.hotspotCommits).toBe(key.plantedCounts.hotspotCommits);
    const counts = extraction.nodes.filter((n) => n.kind === 'code.file' && typeof n.properties.commitCount === 'number')
      .map((n) => [n.key, n.properties.commitCount] as const);
    const best = counts.reduce((a, b) => (Number(b[1]) > Number(a[1]) ? b : a));
    expect(best[0], 'the most frequently changed file').toBe(`code.file:${p}`);
    const nonMerge = commitsOfKind().filter((n) => n.properties.merge !== true);
    expect(nonMerge).toHaveLength(key.plantedCounts.commits - key.plantedCounts.mergeCommits);
  });

  // change-coupling: "pricing.go and tax.go change together: every one of the 6
  // commits that touch either changes both (0 change pricing.go only, 0 change
  // tax.go only). Neither file imports the other."
  test('change-coupling: pricing.go and tax.go change together in 6 commits, none alone', () => {
    const pricing = 'code.file:services/orders/internal/pricing/pricing.go';
    const tax = 'code.file:services/orders/internal/pricing/tax.go';
    const [a, b] = [pricing, tax].sort(byCodePoint);
    const pair = edgesOf('code.changed-with').find((e) => e.from === a && e.to === b);
    expect(pair, 'a coupling edge joins the pair').toBeDefined();
    expect(pair!.properties.support, key.plantedCounts.pricingTogether).toBe(key.plantedCounts.pricingTogether);
    // Nobody touches one without the other: 0 pricing-only, 0 tax-only.
    const touchers = (file: string) => new Set(edgesOf('code.touched').filter((e) => e.to === file).map((e) => e.from));
    expect(touchers(pricing).size, 'the pair\'s commits').toBe(key.plantedCounts.pricingTogether);
    expect([...touchers(pricing)].filter((c) => !touchers(tax).has(c)), 'pricing only').toHaveLength(key.plantedCounts.pricingOnly);
    expect([...touchers(tax)].filter((c) => !touchers(pricing).has(c)), 'tax only').toHaveLength(key.plantedCounts.taxOnly);
    // The pairing carries support only: no other property, no position.
    expect(Object.keys(pair!.properties).sort(byCodePoint)).toEqual(['support']);
  });

  // provider-authorship: "Every commit under services/payments/src/providers is
  // by Rin Tanaka: observed authorship of one person for the whole adapter
  // module."
  test('provider-authorship: every commit in payments/src/providers is by Rin Tanaka', () => {
    const prefix = 'services/payments/src/providers/';
    const files = extraction.nodes.filter((n) => n.kind === 'code.file' && n.key.startsWith(`code.file:${prefix}`));
    expect(files.length, 'the module has its files in the tree').toBeGreaterThan(0);
    for (const file of files) expect(file.properties.authors, file.key).toEqual(['Rin Tanaka']);
    const touched = edgesOf('code.touched').filter((e) => e.to.startsWith(`code.file:${prefix}`));
    expect(touched.length).toBeGreaterThan(0);
    for (const edge of touched) {
      const authored = edgesOf('code.authored').filter((e) => e.to === edge.from);
      expect(authored, edge.from).toHaveLength(1);
      expect(node(authored[0].from).label, edge.from).toBe('Rin Tanaka');
    }
  });

  // date-anomaly: "One commit, "Pin the Go toolchain in the Dockerfiles", has a
  // committer date (2026-09-04) earlier than its parent's (2026-09-14) while its
  // author date is 2026-09-16; the wiki must not order history by committer
  // date alone."
  test('date-anomaly: one out-of-order commit keeps its raw time and takes its parent plus one microsecond', () => {
    const withParent = commitsOfKind()
      .map((n) => ({n, parent: edgesOf('code.parent').find((e) => e.from === n.key && e.properties.position === 1)}))
      .filter((row) => row.parent !== undefined);
    const backwards = withParent.filter((row) => String(row.n.properties.committedAt) < String(node(row.parent!.to).properties.committedAt));
    expect(backwards, 'exactly one commit is out of committer order').toHaveLength(1);
    const anomaly = backwards[0].n;
    expect(anomaly.properties.subject).toBe('Pin the Go toolchain in the Dockerfiles');
    expect(String(anomaly.properties.committedAt).startsWith('2026-09-04'), 'the raw committer time of the key').toBe(true);
    expect(String(anomaly.properties.authoredAt).startsWith('2026-09-16'), 'the author date of the key').toBe(true);
    const parentEffective = String(node(backwards[0].parent!.to).properties.effectiveAt);
    expect(parentEffective.startsWith('2026-09-14'), `the parent's effective time ${parentEffective}`).toBe(true);
    expect(anomaly.properties.effectiveAt, 'the policy: parent effective plus one microsecond').toBe(plusMicro(parentEffective));
  });

  // large-file: "services/payments/src/api/legacy-report.ts is the large file:
  // 796 lines, nine report builders and four output formats in one module."
  test('large-file: legacy-report.ts counts 796 lines', () => {
    const p = 'services/payments/src/api/legacy-report.ts';
    expect(fileNode(p).properties.lines, key.plantedCounts.largeFileLines).toBe(key.plantedCounts.largeFileLines);
    const content = contentAt('snapshot-final', p);
    expect(content, 'the anchor of the key').toContain('FIXME: parameterize these queries');
    expect(content.split('\n').length - 1, 'newline-terminated lines').toBe(key.plantedCounts.largeFileLines);
  });
});
