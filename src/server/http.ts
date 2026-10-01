/**
 * The server's HTTP layer: Bun's own server, no framework (decision 0008),
 * with the ways in (`POST /models`, `POST /views`, `POST /sources`,
 * `GET /sources`) held in one route table, so the next one slots in beside
 * them and authentication can later be added as one layer in front of
 * them, without reshaping either (decision 0012). `POST /sources` is the
 * rename claim: it binds a new name to the id a source already has, and
 * the old name — retired — never grows a second source.
 *
 * Every refusal is JSON `{"error": {"message", "field"?, "accepted"?}}`
 * with 400, 404, 405, 409 or 413; a failure of the server itself is 500,
 * its cause logged at error level, the answer saying it failed without
 * leaking a stack. The store's own refusals (a commit already stored
 * under another model or time) are the history's errors mapped onto 409.
 *
 * One line per request goes to the logger: method, path, status, the
 * source when the request names one, and milliseconds; a refusal adds its
 * message. No model content is ever logged.
 *
 * The body limit is checked twice on purpose: the `content-length` header
 * refuses an over-large body before a byte is read, and the byte count of
 * the read text catches a lying or absent header. Bodies past Bun's own
 * default (128 MB) are never reached by honest clients; a client that
 * lies by omission costs one read, then is refused.
 */
import { Value } from 'typebox/value';
import type { Clock } from '../history/types.js';
import type { CompiledModel } from '../model/compile.js';
import { CompiledModel as CompiledModelSchema } from '../model/compiled-schema.js';
import { byCodePoint } from '../model/order.js';
import { renderOneViewLikeC4, renderOneViewMermaid, type OneViewError, type OneViewRequest } from '../render/one-view.js';
import type { Graphs } from './graphs.js';
import { createGraphs } from './graphs.js';
import type { SourceStoreResult, SourceStores } from './sources.js';
import { createSourceStores, sourceNameProblem } from './sources.js';

/** The largest body the server reads: 50 MB, far past any compiled model sent so far. */
const MAX_BODY_BYTES = 50 * 1024 * 1024;

/** What the server tells a sender whose `committedAt` it refused. */
const ISO_ACCEPTED = 'an ISO 8601 time with a UTC offset, like 2026-09-30T12:34:56Z or 2026-09-30T12:34:56+02:00';

/** What the server tells a requester whose `format` it refused. */
const FORMAT_ACCEPTED = '"mermaid" or "likec4"';

/** What the server tells a requester whose `depth` it refused. */
const DEPTH_ACCEPTED = 'a whole number from 1';

/** The command that sends a model, named in the answer to a source never sent; the command itself lands with the skill's send step. */
const SEND_COMMAND = "bun scripts/send-model.ts <repository> --server <this server's address>";

export interface ServerOptions {
  /** The folder the histories and their sidecars live in; it must exist (see `createSourceStores`). */
  dataFolder: string;
  /** The address to listen on; `127.0.0.1` unless said otherwise (decision 0012). */
  host?: string;
  /** The port to listen on; 4180 by default, 0 for a free port. */
  port?: number;
  /** Supplies recorded time; tests inject a fake clock. */
  clock?: Clock;
  /** Where request lines go; standard output by default. */
  log?: (line: string) => void;
  /** Where error-level lines go; standard error by default. */
  errorLog?: (line: string) => void;
}

export interface StartedServer {
  hostname: string;
  port: number;
  /** The base URL, no trailing slash. */
  url: string;
  /** Stops serving and closes the graphs and the sources' histories. */
  stop(): void;
}

/** One refusal's content, the shape the error answers carry. */
interface Refusal {
  message: string;
  field?: string;
  accepted?: string;
  /**
   * The same refusal as the log line may carry it — field paths, never
   * model values. Left out, the message itself is safe to log: it quotes
   * only request-field values, and no model content.
   */
  logMessage?: string;
}

/** What one route's handling produced, beside the answer itself: what the log line names. */
interface Handled {
  response: Response;
  /** The source the request named, when it named one. */
  source?: string;
  /** The refusal's message, when the answer is a refusal. */
  refusal?: string;
}

/** A sent store request, every field checked and parsed. */
interface SentStore {
  source: string;
  commit: string;
  /** The commit time, parsed from the request's ISO 8601 text to UTC epoch milliseconds. */
  committedAtMs: number;
  model: CompiledModel;
}

/** A view request, every field checked and parsed; `depth` carries its default of 1. */
interface AskedView {
  source: string;
  element?: string;
  depth: number;
  format: 'mermaid' | 'likec4';
}

/** A rename claim, every field checked and parsed. */
interface ClaimedRename {
  /** The id the server assigned the source on its first send. */
  id: string;
  /** The source's new name. */
  source: string;
}

export function startServer(options: ServerOptions): StartedServer {
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  // The writer is the safe place: every line is escaped here once, so a
  // control character in a request field, a commit id or a cause can
  // never split a line again.
  const sink = options.log ?? ((line: string) => console.log(line));
  const errorSink = options.errorLog ?? ((line: string) => console.error(line));
  const log = (line: string) => sink(escapeControlCharacters(line));
  const errorLog = (line: string) => errorSink(escapeControlCharacters(line));
  const sources = createSourceStores({ dataFolder: options.dataFolder, clock, log });
  const graphs = createGraphs({ historyOf: (source) => sources.historyOf(source), clock });
  const handle = createHandler({ sources, graphs, log, errorLog });
  const server = Bun.serve({ hostname: options.host ?? '127.0.0.1', port: options.port ?? 4180, fetch: handle });
  return {
    hostname: server.url.hostname,
    port: server.url.port === '' ? (options.port ?? 4180) : Number(server.url.port),
    url: server.url.origin,
    stop() {
      server.stop(true);
      graphs.close();
      sources.close();
    },
  };
}

function createHandler(dependencies: {
  sources: SourceStores;
  graphs: Graphs;
  log: (line: string) => void;
  errorLog: (line: string) => void;
}): (request: Request) => Promise<Response> {
  const { sources, graphs, log, errorLog } = dependencies;

  /** One way in. A new route is one more entry here, nothing else. */
  interface Route {
    method: string;
    path: string;
    handle: (request: Request) => Handled | Promise<Handled>;
  }

  const routes: Route[] = [
    { method: 'POST', path: '/models', handle: storeModel },
    { method: 'POST', path: '/views', handle: answerView },
    { method: 'POST', path: '/sources', handle: claimRename },
    { method: 'GET', path: '/sources', handle: listSources },
  ];

  function json(status: number, body: unknown, headers?: Record<string, string>): Response {
    return Response.json(body, { status, headers });
  }

  /** A refusal: the error body, the log-safe message kept for the log line — the log form never reaches the client. */
  function refused(status: number, error: Refusal, headers?: Record<string, string>): Handled {
    const { logMessage, ...clientError } = error;
    return { response: json(status, { error: clientError }, headers), refusal: logMessage ?? error.message };
  }

  /** Several collected problems joined into one refusal: the field named when they share one, what is accepted when one answer covers them. */
  function joinedRefusal(status: number, problems: Refusal[]): Handled {
    const error: Refusal = { message: problems.map((problem) => problem.message).join('; ') };
    const fields = new Set(problems.map((problem) => problem.field).filter((field) => field !== undefined));
    const accepteds = new Set(problems.map((problem) => problem.accepted).filter((accepted) => accepted !== undefined));
    if (fields.size === 1) error.field = [...fields][0];
    if (accepteds.size === 1) error.accepted = [...accepteds][0];
    return refused(status, { ...error, logMessage: problems.map((problem) => problem.logMessage ?? problem.message).join('; ') });
  }

  /** The parsed JSON body, or the refusal that replaces it: past the size limit, or not JSON at all. */
  async function jsonBody(request: Request): Promise<{ body?: unknown; bad?: Handled }> {
    const declaredLength = request.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > MAX_BODY_BYTES) {
      return { bad: refused(413, { message: `the body is ${declaredLength} bytes by its own content-length, past the ${MAX_BODY_BYTES}-byte (50 MB) limit` }) };
    }
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
      return { bad: refused(413, { message: `the body is ${Buffer.byteLength(text)} bytes, past the ${MAX_BODY_BYTES}-byte (50 MB) limit` }) };
    }
    try {
      return { body: JSON.parse(text) };
    } catch (error) {
      return { bad: refused(400, { message: `the body is not valid JSON: ${(error as Error).message}` }) };
    }
  }

  async function storeModel(request: Request): Promise<Handled> {
    const { body, bad } = await jsonBody(request);
    if (bad !== undefined) return bad;

    const { sent, problems } = parseStoreRequest(body);
    if (sent === undefined) {
      return { ...joinedRefusal(400, problems), source: namedSourceOf(body) };
    }

    // The old name of a renamed source never grows a second source: the
    // refusal explains the rename and names the name to send under.
    const renamedTo = sources.retiredHead(sent.source);
    if (renamedTo !== undefined) {
      return {
        ...refused(409, {
          field: 'source',
          message: `the source ${JSON.stringify(sent.source)} was renamed to ${JSON.stringify(renamedTo.source)} (id ${JSON.stringify(renamedTo.id)}): the old name holds no source of its own; send under the new name`,
        }),
        source: sent.source,
      };
    }

    let stored: SourceStoreResult;
    try {
      stored = sources.store({
        source: sent.source,
        commit: sent.commit,
        committedAt: sent.committedAtMs,
        model: sent.model,
      });
    } catch (error) {
      // The store's history may already hold the commit — the sidecar
      // write is what failed — so a built engine may now sit behind the
      // history, and the retry this caller will make reports no rows
      // (already stored) that could bring it back in step. Drop the
      // built engines of the graphs listing the source: the next use
      // rebuilds them from the history through the clash check, never
      // from an older model (the precedent of `Graphs.applyStore` for a
      // multi-source graph).
      graphs.dropBuilt(sent.source);
      throw error;
    }
    const { result, wasNew } = stored;
    if (result.errors.length > 0) {
      // The history refused (a commit already stored under another model
      // or time); its error names the commit and the source already.
      return { ...refused(409, { message: result.errors[0]!.message }), source: sent.source };
    }
    graphs.applyStore(sent.source, result);
    if (wasNew) {
      return { response: json(201, { stored: true, source: sent.source, commit: sent.commit }), source: sent.source };
    }
    return { response: json(200, { stored: false, reason: 'already stored', source: sent.source, commit: sent.commit }), source: sent.source };
  }

  /**
   * Everything wrong with a sent store request, and, when nothing is
   * wrong, the request as the store takes it. Every field is checked;
   * none of them stops the rest from being checked too.
   */
  function parseStoreRequest(body: unknown): { sent?: SentStore; problems: Refusal[] } {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { problems: [{ message: 'the body must be a JSON object naming source, commit, committedAt and model' }] };
    }
    const problems: Refusal[] = [];
    for (const key of Object.keys(body).sort(byCodePoint)) {
      if (key !== 'source' && key !== 'commit' && key !== 'committedAt' && key !== 'model') {
        problems.push({ field: key, message: `"${key}" is not a field the server takes: accepted fields are source, commit, committedAt, model` });
      }
    }

    let source: string | undefined;
    if (!('source' in body) || body.source === undefined) {
      problems.push({ field: 'source', message: `"source" is required: the name of the source the model belongs to, like "github.com/shady2k/nocx"` });
    } else {
      const problem = sourceNameProblem(body.source);
      if (problem !== undefined) problems.push({ field: 'source', message: problem });
      if (typeof body.source === 'string') source = body.source;
    }

    let commit: string | undefined;
    if (!('commit' in body) || body.commit === undefined) {
      problems.push({ field: 'commit', message: `"commit" is required: the id of the commit the model was read at` });
    } else if (typeof body.commit !== 'string' || body.commit.length === 0) {
      problems.push({ field: 'commit', message: `"commit" must be a non-empty string naming the commit the model was read at, but is ${JSON.stringify(body.commit)}` });
    } else {
      commit = body.commit;
    }

    let committedAtMs: number | undefined;
    if (!('committedAt' in body) || body.committedAt === undefined) {
      problems.push({ field: 'committedAt', message: `"committedAt" is required: the time the commit was made`, accepted: ISO_ACCEPTED });
    } else if (typeof body.committedAt !== 'string') {
      problems.push({
        field: 'committedAt',
        message: `"committedAt" must be a string holding an ISO 8601 time with an offset, but is ${JSON.stringify(body.committedAt)}`,
        accepted: ISO_ACCEPTED,
      });
    } else {
      const ms = parseIsoWithOffset(body.committedAt);
      if (ms === undefined) {
        problems.push({ field: 'committedAt', message: `"committedAt" ${JSON.stringify(body.committedAt)} is not an ISO 8601 time with an offset`, accepted: ISO_ACCEPTED });
      } else {
        committedAtMs = ms;
      }
    }

    let model: CompiledModel | undefined;
    if (!('model' in body) || body.model === undefined) {
      problems.push({ field: 'model', message: `"model" is required: the compiled model to store` });
    } else {
      const candidate: unknown = body.model;
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        // The value itself is model content: the refusal names the field
        // and the JSON type the field arrived as, never the value.
        const type = candidate === null ? 'null' : Array.isArray(candidate) ? 'array' : typeof candidate;
        problems.push({ field: 'model', message: `"model" must be the compiled model as a JSON object, but is of type ${type}` });
      } else if (!Value.Check(CompiledModelSchema, candidate)) {
        const details = schemaProblems(Value.Errors(CompiledModelSchema, candidate), candidate);
        const detailText = details.map((detail) => (detail.path === '' ? detail.message : `${detail.path}: ${detail.message}`)).join('; ');
        // The log line carries the field paths only: the model's own
        // values stay in the answer to the client, never in the log.
        problems.push({
          field: 'model',
          message: `"model" does not match the compiled model's schema: ${detailText}`,
          logMessage: `"model" does not match the compiled model's schema: ${details.map((detail) => (detail.path === '' ? detail.message : detail.path)).join('; ')}`,
        });
      } else {
        model = candidate;
      }
    }

    if (problems.length > 0 || source === undefined || commit === undefined || committedAtMs === undefined || model === undefined) {
      return { problems };
    }
    return { sent: { source, commit, committedAtMs, model }, problems: [] };
  }

  /**
   * A rename claim: the new name is bound to the id the source already
   * has, the history and its sidecar move to the new name, and the old
   * name is retired — never a source of its own again. A repeat claim of
   * the name the source already holds answers as already answered, and
   * one of its own former names renames it back.
   */
  async function claimRename(request: Request): Promise<Handled> {
    const { body, bad } = await jsonBody(request);
    if (bad !== undefined) return bad;

    const { claim, problems } = parseClaimRequest(body);
    if (claim === undefined) {
      return { ...joinedRefusal(400, problems), source: namedSourceOf(body) };
    }

    const heads = sources.heads();
    const claimed = heads.find((head) => head.id === claim.id);
    if (claimed === undefined) {
      const held = heads.length === 0
        ? 'the server holds no source yet'
        : `the server holds ${heads.map((head) => `"${head.source}" with id "${head.id}"`).join(', ')}`;
      return {
        ...refused(404, {
          field: 'id',
          message: `no source has the id ${JSON.stringify(claim.id)}: ${held}; GET /sources lists every source with its id`,
        }),
      };
    }
    if (claimed.source === claim.source) {
      return { response: json(200, { renamed: false, reason: 'already the name', source: claim.source, id: claim.id }), source: claim.source };
    }
    const holder = heads.find((head) => head.source === claim.source);
    if (holder !== undefined) {
      return {
        ...refused(409, {
          field: 'source',
          message: `the claim renames ${JSON.stringify(claimed.source)} (id ${JSON.stringify(claim.id)}) to ${JSON.stringify(claim.source)}, but that name is already the name of the source with id ${JSON.stringify(holder.id)}: a claim names a name no other source holds`,
        }),
        source: claim.source,
      };
    }
    const retiredHolder = sources.retiredHead(claim.source);
    if (retiredHolder !== undefined && retiredHolder.id !== claim.id) {
      return {
        ...refused(409, {
          field: 'source',
          message: `the claim renames ${JSON.stringify(claimed.source)} (id ${JSON.stringify(claim.id)}) to ${JSON.stringify(claim.source)}, but that name was renamed away from the source with id ${JSON.stringify(retiredHolder.id)} to ${JSON.stringify(retiredHolder.source)}: a claim names a name no other source holds`,
        }),
        source: claim.source,
      };
    }

    sources.rename(claim.id, claim.source);
    graphs.remove(claimed.source);
    return { response: json(200, { renamed: true, source: claim.source, formerSource: claimed.source, id: claim.id }), source: claim.source };
  }

  /**
   * Everything wrong with a rename claim, and, when nothing is wrong,
   * the claim as the rename takes it. Every field is checked; none of
   * them stops the rest from being checked too.
   */
  function parseClaimRequest(body: unknown): { claim?: ClaimedRename; problems: Refusal[] } {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { problems: [{ message: 'the body must be a JSON object naming id and source' }] };
    }
    const problems: Refusal[] = [];
    for (const key of Object.keys(body).sort(byCodePoint)) {
      if (key !== 'id' && key !== 'source') {
        problems.push({ field: key, message: `"${key}" is not a field the server takes: accepted fields are id, source` });
      }
    }

    let id: string | undefined;
    if (!('id' in body) || body.id === undefined) {
      problems.push({ field: 'id', message: `"id" is required: the id the server assigned the source on its first send` });
    } else if (typeof body.id !== 'string' || body.id.length === 0) {
      problems.push({ field: 'id', message: `"id" must be a non-empty string naming the source's id, but is ${JSON.stringify(body.id)}` });
    } else {
      id = body.id;
    }

    let source: string | undefined;
    if (!('source' in body) || body.source === undefined) {
      problems.push({ field: 'source', message: `"source" is required: the source's new name, like "github.com/shady2k/nocx"` });
    } else {
      const problem = sourceNameProblem(body.source);
      if (problem !== undefined) problems.push({ field: 'source', message: problem });
      if (typeof body.source === 'string') source = body.source;
    }

    if (problems.length > 0 || id === undefined || source === undefined) {
      return { problems };
    }
    return { claim: { id, source }, problems: [] };
  }

  /**
   * A view request: answered from the source's graph's query engine and
   * the source's compiled model (the history's latest read of it), at the
   * current time and the first state — the engine's own defaults, which
   * reduce to the history's own times, so no clock moment of the server's
   * own leaks into the text. A request that cannot be answered is
   * explained, never answered with an empty diagram.
   */
  async function answerView(request: Request): Promise<Handled> {
    const { body, bad } = await jsonBody(request);
    if (bad !== undefined) return bad;

    const { asked, problems } = parseViewRequest(body);
    if (asked === undefined) {
      return { ...joinedRefusal(400, problems), source: namedSourceOf(body) };
    }

    const heads = sources.heads();
    if (!heads.some((head) => head.source === asked.source)) {
      const renamedTo = sources.retiredHead(asked.source);
      if (renamedTo !== undefined) {
        return {
          ...refused(404, {
            field: 'source',
            message: `the source ${JSON.stringify(asked.source)} was renamed to ${JSON.stringify(renamedTo.source)} (id ${JSON.stringify(renamedTo.id)}): ask under the new name`,
          }),
          source: asked.source,
        };
      }
      const held = heads.map((head) => head.source);
      const holds = held.length === 0 ? 'the server holds no source yet' : `the server holds ${held.join(', ')}`;
      return {
        ...refused(404, {
          field: 'source',
          message: `no model has been sent for the source ${JSON.stringify(asked.source)}: ${holds}; send one with: ${SEND_COMMAND}`,
        }),
        source: asked.source,
      };
    }

    const read = sources.historyOf(asked.source).read({ source: asked.source });
    if (read.model === undefined || read.errors.length > 0) {
      const why = read.errors.map((error) => error.message).join('; ');
      // The failure of the server itself is logged at error level with
      // its cause; the answer says what failed without a stack.
      const message = `the model of the source ${JSON.stringify(asked.source)} could not be read from its history: ${why || 'nothing was read'}`;
      errorLog(message);
      return {
        ...refused(500, { message }),
        source: asked.source,
      };
    }
    // A source-filtered read returns that source's own compiled model,
    // byte for byte what its store was given (the history's lossless rule).
    const model = read.model as CompiledModel;
    const engine = graphs.graphForSource(asked.source).engine();
    const one: OneViewRequest = asked.element === undefined ? { depth: asked.depth } : { element: asked.element, depth: asked.depth };

    if (asked.format === 'mermaid') {
      const rendered = renderOneViewMermaid(engine, model, one);
      if (rendered.page === undefined) return { ...renderRefusal(asked, rendered.errors), source: asked.source };
      return { response: new Response(rendered.page, { headers: { 'content-type': 'text/markdown; charset=utf-8' } }), source: asked.source };
    }
    const rendered = renderOneViewLikeC4(engine, model, one);
    if (rendered.workspace === undefined) return { ...renderRefusal(asked, rendered.errors), source: asked.source };
    // A relation LikeC4 cannot draw (of an element to itself or its own
    // descendant) is named in one comment line at the top of the answer,
    // before the workspace text, in code point order of relation id, so
    // nothing the model holds is dropped silently and the text still
    // validates on its own; no model content goes to the log.
    const notDrawn = [...(rendered.notDrawn ?? [])].sort((a, b) => byCodePoint(a.relationId, b.relationId));
    const text = notDrawn.length === 0
      ? rendered.workspace
      : `${notDrawn.map((relation) => `// not drawn: ${relation.message}`).join('\n')}\n${rendered.workspace}`;
    return { response: new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } }), source: asked.source };
  }

  /**
   * A view the renderer could not render: an element the source's model
   * does not hold now is a 404 naming the element and the source (the
   * explains requirement); every other renderer error is passed on with
   * its messages, never swallowed.
   */
  function renderRefusal(asked: AskedView, errors: OneViewError[]): Handled {
    if (asked.element !== undefined && errors.some((error) => error.query?.id === asked.element)) {
      return refused(404, {
        field: 'element',
        message: `the element ${JSON.stringify(asked.element)} does not exist in the source ${JSON.stringify(asked.source)} now`,
      });
    }
    // A renderer failure that is not the asked element's own (that one
    // is a 404 above) is the server failing: logged at error level.
    const message = errors.map((error) => error.message).join('; ');
    errorLog(message);
    return refused(500, { message });
  }

  /**
   * Everything wrong with a view request, and, when nothing is wrong, the
   * request as the answer takes it. Every field is checked; none of them
   * stops the rest from being checked too.
   */
  function parseViewRequest(body: unknown): { asked?: AskedView; problems: Refusal[] } {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { problems: [{ message: 'the body must be a JSON object naming source and format, with element and depth beside them when they are wanted' }] };
    }
    const problems: Refusal[] = [];
    for (const key of Object.keys(body).sort(byCodePoint)) {
      if (key !== 'source' && key !== 'element' && key !== 'depth' && key !== 'format') {
        problems.push({ field: key, message: `"${key}" is not a field the server takes: accepted fields are source, element, depth, format` });
      }
    }

    let source: string | undefined;
    if (!('source' in body) || body.source === undefined) {
      problems.push({ field: 'source', message: '"source" is required: the name of the source the view is asked of, like "github.com/shady2k/nocx"' });
    } else {
      const problem = sourceNameProblem(body.source);
      if (problem !== undefined) problems.push({ field: 'source', message: problem });
      if (typeof body.source === 'string') source = body.source;
    }

    let element: string | undefined;
    if ('element' in body && body.element !== undefined) {
      if (typeof body.element === 'string' && body.element.length > 0) {
        element = body.element;
      } else {
        problems.push({ field: 'element', message: `"element" must be a string naming an element of the source's model, or left out for the landscape, but is ${JSON.stringify(body.element)}` });
      }
    }

    let depth = 1;
    if ('depth' in body && body.depth !== undefined) {
      const value: unknown = body.depth;
      if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
        depth = value;
      } else {
        problems.push({
          field: 'depth',
          message: typeof value === 'number' && Number.isInteger(value)
            ? `"depth" ${value} is below 1: the depth is ${DEPTH_ACCEPTED}`
            : `"depth" ${JSON.stringify(value)} is not ${DEPTH_ACCEPTED}`,
          accepted: DEPTH_ACCEPTED,
        });
      }
    }

    let format: AskedView['format'] | undefined;
    if (!('format' in body) || body.format === undefined) {
      problems.push({ field: 'format', message: '"format" is required: the format the view is rendered as', accepted: FORMAT_ACCEPTED });
    } else if (body.format === 'mermaid' || body.format === 'likec4') {
      format = body.format;
    } else {
      problems.push({ field: 'format', message: `"format" ${JSON.stringify(body.format)} is not a format the server renders`, accepted: FORMAT_ACCEPTED });
    }

    if (problems.length > 0 || source === undefined || format === undefined) {
      return { problems };
    }
    return { asked: { source, element, depth, format }, problems: [] };
  }

  function listSources(): Handled {
    const list = sources.heads().map((head) => ({
      source: head.source,
      id: head.id,
      commit: head.commit,
      committedAt: new Date(head.committedAt).toISOString(),
      storedAt: new Date(head.storedAt).toISOString(),
    }));
    return { response: json(200, list) };
  }

  return async (request: Request): Promise<Response> => {
    const started = performance.now();
    const pathname = new URL(request.url).pathname;
    let handled: Handled;
    try {
      const onPath = routes.filter((each) => each.path === pathname);
      if (onPath.length === 0) {
        handled = refused(404, {
          message: `no such path "${pathname}": the server offers ${routes.map((each) => `${each.method} ${each.path}`).join(', ')}`,
        });
      } else {
        const route = onPath.find((each) => each.method === request.method);
        if (route === undefined) {
          const offered = onPath.map((each) => each.method).join(', ');
          handled = refused(405, { message: `"${request.method}" is not offered on "${onPath[0]!.path}": use ${offered}` }, { allow: offered });
        } else {
          handled = await route.handle(request);
        }
      }
    } catch (error) {
      const cause = error instanceof Error ? (error.stack ?? error.message) : String(error);
      errorLog(`the server failed to handle ${request.method} ${pathname}: ${cause}`);
      handled = { response: json(500, { error: { message: 'the request failed inside the server' } }) };
    }
    const ms = Math.max(0, Math.round(performance.now() - started));
    const named = handled.source === undefined ? '' : ` source=${JSON.stringify(handled.source)}`;
    const why = handled.refusal === undefined ? '' : `: ${handled.refusal}`;
    log(`${request.method} ${pathname} ${handled.response.status}${named} ${ms}ms${why}`);
    return handled.response;
  };
}

/** The escape itself: the readable forms for the line breaks and the tab, `\uXXXX` for every other control character. */
function escapeControlCharacters(line: string): string {
  return line.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, (ch) => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/** The source a request body named, when it named one — even one arriving beside other broken fields. */
function namedSourceOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !('source' in body)) return undefined;
  const candidate: unknown = body.source;
  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * The ISO 8601 times the server accepts, as UTC epoch milliseconds, or
 * `undefined` for anything else: a date, a time without its offset, a
 * month that does not exist. The parts are checked by hand rather than
 * handed to `Date.parse`, which accepts far more than ISO 8601 (and
 * rolls out-of-range parts over silently).
 */
function parseIsoWithOffset(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (match === null) return undefined;
  const year = match[1]!;
  const month = match[2]!;
  const day = match[3]!;
  const hour = match[4]!;
  const minute = match[5]!;
  const second = match[6]!;
  const fraction = match[7];
  const offset = match[8]!;
  if (Number(month) < 1 || Number(month) > 12) return undefined;
  if (Number(day) < 1 || Number(day) > daysInMonth(Number(year), Number(month))) return undefined;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return undefined;
  let offsetMinutes = 0;
  if (offset !== 'Z') {
    const hours = Number(offset.slice(1, 3));
    const minutes = Number(offset.slice(4, 6));
    if (hours > 23 || minutes > 59) return undefined;
    offsetMinutes = (hours * 60 + minutes) * (offset[0] === '-' ? -1 : 1);
  }
  const fractionMs = fraction === undefined ? 0 : Math.round(Number(`0.${fraction}`) * 1000);
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), fractionMs) - offsetMinutes * 60_000;
}

/** The number of days in a month, leap years included (`Date.UTC(y, m, 0)` lands on the month's last day). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** One path that does not match the compiled model's schema, named the way the refusals name paths. */
interface SchemaDetail {
  path: string;
  message: string;
}

/**
 * TypeBox's raw errors turned into one clear detail per actual problem —
 * the same reading `src/model/load.ts` does for file errors, kept to the
 * schema's own shapes here: an unknown field named at its own path once
 * (not twice), a missing field named at the field's own path, a literal
 * or a union of literals answered with everything it could have been,
 * and every other complaint kept only where nothing clearer replaces it.
 */
function schemaProblems(
  raw: Iterable<{ keyword: string; instancePath: string; params: Record<string, unknown>; message: string }>,
  root: unknown,
): SchemaDetail[] {
  const byPath = new Map<string, string>();
  const constGroups = new Map<string, unknown[]>();
  const deferred: { path: string; message: string }[] = [];

  for (const error of raw) {
    if (error.keyword === 'const') {
      const group = constGroups.get(error.instancePath);
      if (group === undefined) constGroups.set(error.instancePath, [error.params.allowedValue]);
      else group.push(error.params.allowedValue);
    } else if (error.keyword === 'boolean') {
      continue; // the unknown-field error at the same shape is clearer
    } else if (error.keyword === 'additionalProperties') {
      const names = Array.isArray(error.params.additionalProperties) ? error.params.additionalProperties : [];
      for (const name of names) byPath.set(`${error.instancePath}/${String(name)}`, `unknown field "${String(name)}"`);
    } else if (error.keyword === 'required') {
      const names = Array.isArray(error.params.requiredProperties) ? error.params.requiredProperties : [];
      for (const name of names) byPath.set(`${error.instancePath}/${String(name)}`, `missing required field "${String(name)}"`);
    } else {
      deferred.push({ path: error.instancePath, message: error.message });
    }
  }
  for (const { path, message } of deferred) {
    if (!constGroups.has(path) && !byPath.has(path)) byPath.set(path, message);
  }
  for (const [path, allowed] of constGroups) {
    const segments = path.split('/').filter((segment) => segment.length > 0);
    const field = segments[segments.length - 1] ?? path;
    byPath.set(path, `${JSON.stringify(valueAtPointer(root, path))} is not a known "${field}": expected one of ${allowed.map((each) => JSON.stringify(each)).join(', ')}`);
  }
  return [...byPath].map(([path, message]) => ({ path, message })).sort((a, b) => byCodePoint(a.path, b.path));
}

/** Reads the value a JSON pointer names, for saying what was actually there. */
function valueAtPointer(root: unknown, pointer: string): unknown {
  let current = root;
  for (const segment of pointer.split('/')) {
    if (segment.length === 0) continue;
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
