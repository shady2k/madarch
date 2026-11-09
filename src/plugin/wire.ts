/**
 * The bytes of the host/plugin protocol (`protocol.ts` is the shapes): one
 * newline delimits one message, and one message may not pass the host's bound.
 * A reader that meets a longer line fails at once — it does not keep the
 * plugin's flood in memory to read it later.
 */
import type { PluginErrorReport, PluginHeartbeat, PluginProgress } from './protocol.js';

/** The JSON-RPC error codes this protocol uses (the specification's own, and the plugin's range). */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;

/** One message read off the wire: its text, and what it weighed. */
export interface WireMessage {
  readonly value: unknown;
  readonly bytes: number;
}

export interface LineReader {
  /** Reads one chunk; `onLine` sees each whole line, `onOverflow` the first one past the bound. */
  push(chunk: Uint8Array, onLine: (message: WireMessage) => void, onOverflow: (bytes: number) => void): void;
  /** The bytes held so far, for a message still arriving. */
  held(): number;
}

/**
 * A reader of one plugin's standard output: line delimited JSON, one message
 * at a time, with a bound on the bytes of one message. The buffer holds bytes,
 * not text, so a message cut in the middle of a UTF-8 sequence is not misread
 * as two.
 */
export function lineReader(maxMessageBytes: number): LineReader {
  let buffer: Uint8Array = new Uint8Array(0);
  let overflowing = false;
  return {
    push(chunk, onLine, onOverflow) {
      if (overflowing) return;
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer, 0);
      joined.set(chunk, buffer.length);
      buffer = joined;
      let newline = buffer.indexOf(0x0a);
      while (newline !== -1) {
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length > maxMessageBytes) {
          overflowing = true;
          onOverflow(line.length);
          return;
        }
        const text = Buffer.from(line).toString('utf8');
        if (text.trim() !== '') {
          // A line that is not JSON is the plugin's own malformed message: it is handed on as a parse failure, so
          // the handshake or the unit fails with the cause named, never swallowed.
          onLine({ value: parsedOrFailure(text), bytes: line.length });
        }
        newline = buffer.indexOf(0x0a);
      }
      if (buffer.length > maxMessageBytes) {
        overflowing = true;
        onOverflow(buffer.length);
      }
    },
    held: () => buffer.length,
  };
}

/** A line read as JSON, or the failure that says it was not: a message no one may answer is still an answer. */
function parsedOrFailure(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    return { parseFailure: (error as Error).message, text: text.slice(0, 200) };
  }
}

/** One request as the host writes it: the id it answers by, the method and the params. */
export function requestText(id: number | string, method: string, params?: unknown): string {
  return `${JSON.stringify(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params })}\n`;
}

/** One notification as either side writes it: a method and its params, and no id. */
export function notificationText(method: string, params?: unknown): string {
  return `${JSON.stringify(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })}\n`;
}

/** The answer to a request that succeeded. */
export function successText(id: number | string, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
}

/** The answer to a request that failed, with the cause in its data. */
export function failureText(id: number | string | null, code: number, message: string, data?: { cause?: string; unitId?: string }): string {
  const error = data === undefined ? { code, message } : { code, message, data };
  return `${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`;
}

/** Whether a message is a JSON-RPC request: an id and a method. */
export function isRequest(value: unknown): value is { jsonrpc: '2.0'; id: number | string; method: string; params?: unknown } {
  if (typeof value !== 'object' || value === null) return false;
  const held = value as Record<string, unknown>;
  return held['jsonrpc'] === '2.0' && (typeof held['id'] === 'string' || typeof held['id'] === 'number') && typeof held['method'] === 'string';
}

/** Whether a message is a JSON-RPC notification: a method and no id. */
export function isNotification(value: unknown): value is { jsonrpc: '2.0'; method: string; params?: unknown } {
  if (typeof value !== 'object' || value === null) return false;
  const held = value as Record<string, unknown>;
  return held['jsonrpc'] === '2.0' && !('id' in held) && typeof held['method'] === 'string';
}

/** Whether a message answers a request. */
export function isResponse(value: unknown): value is { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: { code: number; message: string; data?: { cause?: string; unitId?: string } } } {
  if (typeof value !== 'object' || value === null) return false;
  const held = value as Record<string, unknown>;
  if (held['jsonrpc'] !== '2.0' || !('id' in held)) return false;
  return 'result' in held || 'error' in held;
}

/** The heartbeat params a notification carries, or undefined when it is no heartbeat. */
export function heartbeatOf(value: unknown): PluginHeartbeat | undefined {
  if (!isNotification(value) || value.method !== 'heartbeat') return undefined;
  const params = value.params;
  if (params === undefined) return {};
  if (typeof params !== 'object' || params === null) return {};
  const unitId = (params as Record<string, unknown>)['unitId'];
  return typeof unitId === 'string' ? { unitId } : {};
}

/** The progress params a notification carries, or undefined when it is no progress report. */
export function progressOf(value: unknown): PluginProgress | undefined {
  if (!isNotification(value) || value.method !== 'progress') return undefined;
  const params = value.params;
  if (typeof params !== 'object' || params === null) return undefined;
  const held = params as Record<string, unknown>;
  if (typeof held['unitId'] !== 'string') return undefined;
  const progress: PluginProgress = { unitId: held['unitId'] };
  if (typeof held['done'] === 'number') (progress as { done?: number }).done = held['done'];
  if (typeof held['total'] === 'number') (progress as { total?: number }).total = held['total'];
  if (typeof held['note'] === 'string') (progress as { note?: string }).note = held['note'];
  return progress;
}

/** The error a plugin reported, or undefined when the notification is none. */
export function errorReportOf(value: unknown): PluginErrorReport | undefined {
  if (!isNotification(value) || value.method !== 'error') return undefined;
  const params = value.params;
  if (typeof params !== 'object' || params === null) return undefined;
  const held = params as Record<string, unknown>;
  if (typeof held['code'] !== 'string' || typeof held['message'] !== 'string') return undefined;
  const report: PluginErrorReport = { code: held['code'], message: held['message'] };
  if (typeof held['unitId'] === 'string') (report as { unitId?: string }).unitId = held['unitId'];
  if (typeof held['file'] === 'string') (report as { file?: string }).file = held['file'];
  if (typeof held['line'] === 'number') (report as { line?: number }).line = held['line'];
  return report;
}
