import { byCodePoint } from '../../model/order.js';
import { sameGuideContext } from './digest.js';
import { GUIDE_SCHEMA, type GuideDiagnostic, type GuideDocument, type GuideValidationHost } from './model.js';

const checkedGuides = new WeakSet<object>();
export function isCheckedGuide(guide: GuideDocument): boolean { return checkedGuides.has(guide); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
const lower = (character: string): boolean => character >= 'a' && character <= 'z';
const digit = (character: string): boolean => character >= '0' && character <= '9';
const upper = (character: string): boolean => character >= 'A' && character <= 'Z';
const identity = (value: string): boolean => {
  if (value.length === 0 || !lower(value[0]!)) return false;
  let hyphen = false;
  for (let index = 1; index < value.length; index++) {
    const character = value[index]!;
    if (character === '-') { if (hyphen) return false; hyphen = true; }
    else { if (!lower(character) && !digit(character)) return false; hyphen = false; }
  }
  return !hyphen;
};
const hexadecimal = (value: string, minimum: number, maximum = minimum): boolean => {
  if (value.length < minimum || value.length > maximum) return false;
  for (const character of value) if (!digit(character) && !(character >= 'a' && character <= 'f')) return false;
  return true;
};
const inputName = (value: string): boolean => {
  if (value.length === 0 || !upper(value[0]!)) return false;
  for (const character of value) if (!upper(character) && !digit(character) && character !== '_') return false;
  return true;
};
const plain = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.trim() === '') return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31) return false;
  }
  return true;
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const safeGuidePath = (value: string, root = false): boolean => (root && value === '.') ||
  (value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && !value.split('/').some((part) => part === '' || part === '.' || part === '..'));
const instant = (value: unknown): boolean => {
  if (typeof value !== 'string' || value.length < 13 || value[4] !== '-' || value[7] !== '-' || value[10] !== 'T' || !value.endsWith('Z')) return false;
  for (const index of [0, 1, 2, 3, 5, 6, 8, 9]) if (!digit(value[index]!)) return false;
  for (const character of value.slice(11, -1)) if (character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029') return false;
  return Number.isFinite(Date.parse(value));
};
export type GuideValidation = { readonly ok: true; readonly guide: GuideDocument } | { readonly ok: false; readonly diagnostics: readonly GuideDiagnostic[] };

/** Structural checks precede host evidence checks. Agent-supplied approval fields are refused. */
export async function validateGuide(input: unknown, host: GuideValidationHost): Promise<GuideValidation> {
  const diagnostics: GuideDiagnostic[] = [];
  const error = (path: string, code: string, message: string): void => { diagnostics.push({ file: host.file, line: 1, path, code, message: `${host.file}:1: ${path}: ${message}` }); };
  const done = (): GuideValidation => ({ ok: false, diagnostics: diagnostics.sort((a, b) => byCodePoint(a.path, b.path) || byCodePoint(a.code, b.code) || byCodePoint(a.message, b.message)) });
  const text = (value: unknown, path: string): void => {
    if (!plain(value)) { error(path, 'text', 'expected non-blank text without control characters'); return; }
    if (value.length > 16000) error(path, 'bound', 'text exceeds 16000 characters');
  };
  const list = (value: unknown, path: string): void => {
    if (!Array.isArray(value) || value.length > 100) { error(path, 'list', 'expected at most 100 text entries'); return; }
    value.forEach((entry, index) => text(entry, `${path}[${index}]`));
  };
  const fields = (value: Record<string, unknown>, allowed: readonly string[], path: string): void => {
    for (const [index, key] of Object.keys(value).sort(byCodePoint).entries()) if (!allowed.includes(key)) error(`${path}.$keys[${index}]`, 'unknown-field', 'field is not part of the guide format');
  };
  let encoded: string;
  try { encoded = JSON.stringify(input); } catch { error('$', 'plain-data', 'expected bounded serializable data'); return done(); }
  if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).length > 128 * 1024) { error('$', 'bound', 'guide exceeds 131072 bytes or is not serializable'); return done(); }
  // Inspect the parsed data tree, not JSON-escaped bytes. Authored strings and unknown member names
  // are checked before any verifier; exact host-bound typed proof metadata is not authored text.
  // Use the same plain snapshot for inspection and validation; getters/toJSON cannot swap later inputs.
  input = JSON.parse(encoded) as unknown;
  if (typeof host.containsSecret !== 'function') { error('$', 'verification-unavailable', 'secret verification is unavailable'); return done(); }
  const sensitive = (value: string, path: string): boolean => {
    try {
      const result = host.containsSecret(value);
      if (typeof result !== 'boolean') { error(path, 'verification-unavailable', 'secret verification did not return a result'); return true; }
      if (result) { error(path, 'secret', 'sensitive value is not allowed in the artifact'); return true; }
      return false;
    } catch { error(path, 'verification-unavailable', 'secret verification failed'); return true; }
  };
  // Only schema-typed, host-bound proof coordinates are metadata. Authored text and unknown
  // member names still pass the complete pre-verifier check; fixed schema keys are not prose.
  const proofMetadata = new Set<string>();
  const schemaKeys = new Map<string, ReadonlySet<string>>();
  const keysAt = (path: string, keys: readonly string[]): void => { schemaKeys.set(path, new Set(keys)); };
  if (object(input)) {
    keysAt('$', ['schema', 'id', 'kind', 'locale', 'title', 'context', 'unitVersion', 'inputDigest', 'prerequisites', 'gaps', 'procedures']);
    if (input['schema'] === GUIDE_SCHEMA) proofMetadata.add('$.schema');
    if (input['kind'] === 'administrator-guide' || input['kind'] === 'user-guide') proofMetadata.add('$.kind');
    if (input['locale'] === 'en' || input['locale'] === 'ru') proofMetadata.add('$.locale');
    if (plain(input['unitVersion']) && input['unitVersion'] === host.expectedUnitVersion) proofMetadata.add('$.unitVersion');
    if (typeof input['inputDigest'] === 'string' && hexadecimal(input['inputDigest'], 64) && input['inputDigest'] === host.expectedInputDigest) proofMetadata.add('$.inputDigest');
    const heldContext = input['context'];
    const hostPins = host.expectedContext.repositories;
    if (object(heldContext)) {
      keysAt('$.context', ['valid', 'known', 'state', 'repositories']);
      for (const field of ['valid', 'known'] as const) if (instant(heldContext[field]) && heldContext[field] === host.expectedContext[field]) proofMetadata.add(`$.context.${field}`);
      if (typeof heldContext['state'] === 'string' && heldContext['state'].length > 0 && [...heldContext['state']].every(digit) && heldContext['state'] === host.expectedContext.state) proofMetadata.add('$.context.state');
      if (Array.isArray(heldContext['repositories'])) heldContext['repositories'].forEach((repository: unknown, index: number) => {
        if (!object(repository)) return;
        keysAt(`$.context.repositories[${index}]`, ['name', 'commit']);
        if (!hostPins.some((pin) => pin.name === repository['name'] && pin.commit === repository['commit'])) return;
        if (plain(repository['name']) && identity(repository['name'])) proofMetadata.add(`$.context.repositories[${index}].name`);
        if (typeof repository['commit'] === 'string' && hexadecimal(repository['commit'], 40, 64)) proofMetadata.add(`$.context.repositories[${index}].commit`);
      });
    }
    const heldProcedures = input['procedures'];
    if (Array.isArray(heldProcedures)) heldProcedures.forEach((procedure: unknown, pi: number) => {
      if (!object(procedure)) return;
      keysAt(`$.procedures[${pi}]`, ['id', 'title', 'goal', 'role', 'prerequisites', 'steps']);
      if (!Array.isArray(procedure['steps'])) return;
      procedure['steps'].forEach((step: unknown, si: number) => {
        if (!object(step)) return;
        const stepPath = `$.procedures[${pi}].steps[${si}]`;
        keysAt(stepPath, ['id', 'title', 'cwd', 'environment', 'inputs', 'instruction', 'expected', 'grounds']);
        if (object(step['instruction'])) {
          keysAt(`${stepPath}.instruction`, ['kind', 'content']);
          if (step['instruction']['kind'] === 'command' || step['instruction']['kind'] === 'http') proofMetadata.add(`${stepPath}.instruction.kind`);
        }
        if (object(step['expected'])) keysAt(`${stepPath}.expected`, ['status', 'observation']);
        if (Array.isArray(step['inputs'])) step['inputs'].forEach((entry: unknown, ii: number) => { if (object(entry)) keysAt(`${stepPath}.inputs[${ii}]`, ['name', 'description', 'secret']); });
        if (!Array.isArray(step['grounds'])) return;
        step['grounds'].forEach((ground: unknown, gi: number) => {
          if (!object(ground)) return;
          const path = `$.procedures[${pi}].steps[${si}].grounds[${gi}]`;
          keysAt(path, ['repository', 'commit', 'path', 'line', 'endLine']);
          if (!hostPins.some((pin) => pin.name === ground['repository'] && pin.commit === ground['commit'])) return;
          proofMetadata.add(`${path}.repository`);
          if (typeof ground['commit'] === 'string' && hexadecimal(ground['commit'], 40, 64)) proofMetadata.add(`${path}.commit`);
        });
      });
    });
  }
  const knownFields = new Set(['schema', 'id', 'kind', 'locale', 'title', 'context', 'unitVersion', 'inputDigest', 'prerequisites', 'gaps', 'procedures', 'valid', 'known', 'state', 'repositories', 'name', 'commit', 'goal', 'role', 'steps', 'cwd', 'environment', 'inputs', 'instruction', 'expected', 'grounds', 'description', 'secret', 'content', 'status', 'observation', 'repository', 'path', 'line', 'endLine']);
  const pending: { value: unknown; path: string }[] = [{ value: input, path: '$' }];
  while (pending.length > 0) {
    const held = pending.pop()!;
    if (typeof held.value === 'string') { if (!proofMetadata.has(held.path)) sensitive(held.value, held.path); continue; }
    if (Array.isArray(held.value)) {
      held.value.forEach((value, index) => pending.push({ value, path: `${held.path}[${index}]` }));
    } else if (object(held.value)) {
      for (const [index, key] of Object.keys(held.value).sort(byCodePoint).entries()) {
        // Never put a sensitive member name into a diagnostic, including an ancestor of a value.
        if (!schemaKeys.get(held.path)?.has(key) && sensitive(key, `${held.path}.$keys[${index}]`)) continue;
        const named = knownFields.has(key);
        pending.push({ value: held.value[key], path: named ? `${held.path}.${key}` : `${held.path}.$members[${index}]` });
      }
    }
  }
  if (diagnostics.length > 0) return done();
  if (!object(input)) { error('$', 'object', 'expected a guide object'); return done(); }
  fields(input, ['schema', 'id', 'kind', 'locale', 'title', 'context', 'unitVersion', 'inputDigest', 'prerequisites', 'gaps', 'procedures'], '$');
  if (input['schema'] !== GUIDE_SCHEMA) error('$.schema', 'schema', `expected ${GUIDE_SCHEMA}`);
  if (!plain(input['id']) || (!identity(input['id']) && !((input['kind'] === 'administrator-guide' || input['kind'] === 'user-guide') && input['id'] === `${input['kind']}:main`))) error('$.id', 'identity', 'expected a lower-case hyphenated identity or the registered guide identity');
  if (!['administrator-guide', 'user-guide'].includes(String(input['kind']))) error('$.kind', 'kind', 'expected administrator-guide or user-guide');
  if (!['en', 'ru'].includes(String(input['locale']))) error('$.locale', 'locale', 'expected en or ru');
  text(input['title'], '$.title'); text(input['unitVersion'], '$.unitVersion');
  if (input['unitVersion'] !== host.expectedUnitVersion) error('$.unitVersion', 'stale-version', 'unit version differs from host context');
  if (typeof input['inputDigest'] !== 'string' || !hexadecimal(input['inputDigest'], 64)) error('$.inputDigest', 'digest', 'expected a SHA-256 digest');
  if (input['inputDigest'] !== host.expectedInputDigest) error('$.inputDigest', 'stale-input', 'input digest differs from host context');
  const context = input['context']; const repositories = new Map<string, string>();
  if (!object(context)) error('$.context', 'context', 'expected a full pinned temporal context');
  else {
    fields(context, ['valid', 'known', 'state', 'repositories'], '$.context');
    for (const key of ['valid', 'known']) if (!instant(context[key])) error(`$.context.${key}`, 'instant', 'expected a UTC instant');
    text(context['state'], '$.context.state');
    if (!Array.isArray(context['repositories']) || context['repositories'].length === 0 || context['repositories'].length > 50) error('$.context.repositories', 'repositories', 'expected 1 to 50 pinned repositories');
    else context['repositories'].forEach((repository: unknown, index: number) => {
      const path = `$.context.repositories[${index}]`;
      if (!object(repository)) { error(path, 'repository', 'expected a named pinned repository'); return; }
      fields(repository, ['name', 'commit'], path);
      if (!plain(repository['name']) || !identity(repository['name'])) error(`${path}.name`, 'repository', 'expected repository identity');
      if (!plain(repository['commit']) || !hexadecimal(repository['commit'], 40, 64)) error(`${path}.commit`, 'commit', 'expected a full commit hash');
      if (typeof repository['name'] === 'string' && typeof repository['commit'] === 'string') {
        if (repositories.has(repository['name'])) error(`${path}.name`, 'duplicate', 'repository is named twice');
        repositories.set(repository['name'], repository['commit']);
      }
    });
  }
  list(input['prerequisites'], '$.prerequisites'); list(input['gaps'], '$.gaps');
  const procedures = input['procedures'];
  // A gap-only artifact records absent source proof; it does not fulfill guide coverage or certify a walk.
  if (!Array.isArray(procedures) || procedures.length > 40 || procedures.length === 0 && (!Array.isArray(input['gaps']) || input['gaps'].length === 0)) error('$.procedures', 'procedures', 'expected 1 to 40 procedures, or an explicit gap when no procedure is evidenced');
  else {
    const procedureIds = new Set<string>();
    procedures.forEach((procedure: unknown, pi: number) => {
      const path = `$.procedures[${pi}]`;
      if (!object(procedure)) { error(path, 'procedure', 'expected a procedure object'); return; }
      fields(procedure, ['id', 'title', 'goal', 'role', 'prerequisites', 'steps'], path);
      const id = procedure['id'];
      if (!plain(id) || !identity(id)) error(`${path}.id`, 'identity', 'expected a procedure identity');
      else { if (procedureIds.has(id)) error(`${path}.id`, 'duplicate', 'procedure identity is repeated'); procedureIds.add(id); }
      for (const field of ['title', 'goal', 'role']) text(procedure[field], `${path}.${field}`);
      list(procedure['prerequisites'], `${path}.prerequisites`);
      const steps = procedure['steps'];
      if (!Array.isArray(steps) || steps.length === 0 || steps.length > 60) { error(`${path}.steps`, 'steps', 'expected 1 to 60 steps'); return; }
      const stepIds = new Set<string>();
      steps.forEach((step: unknown, si: number) => {
        const sp = `${path}.steps[${si}]`;
        if (!object(step)) { error(sp, 'step', 'expected a step object'); return; }
        fields(step, ['id', 'title', 'cwd', 'environment', 'inputs', 'instruction', 'expected', 'grounds'], sp);
        const sid = step['id'];
        if (!plain(sid) || !identity(sid)) error(`${sp}.id`, 'identity', 'expected a step identity');
        else { if (stepIds.has(sid)) error(`${sp}.id`, 'duplicate', 'step identity is repeated'); stepIds.add(sid); }
        text(step['title'], `${sp}.title`); text(step['environment'], `${sp}.environment`);
        if (typeof step['cwd'] !== 'string' || !safeGuidePath(step['cwd'], true)) error(`${sp}.cwd`, 'path', 'expected a safe repository-relative working directory');
        const inputs = step['inputs'];
        if (!Array.isArray(inputs) || inputs.length > 40) error(`${sp}.inputs`, 'inputs', 'expected at most 40 named inputs');
        else {
          const names = new Set<string>();
          inputs.forEach((entry: unknown, ii: number) => {
            const ip = `${sp}.inputs[${ii}]`;
            if (!object(entry)) { error(ip, 'input', 'expected an input object'); return; }
            fields(entry, ['name', 'description', 'secret'], ip);
            if (!plain(entry['name']) || !inputName(entry['name'])) error(`${ip}.name`, 'input-name', 'expected uppercase input name');
            else { if (names.has(entry['name'])) error(`${ip}.name`, 'duplicate', 'input name is repeated'); names.add(entry['name']); }
            text(entry['description'], `${ip}.description`);
            if (typeof entry['secret'] !== 'boolean') error(`${ip}.secret`, 'input-secret', 'expected a boolean, never a secret value');
          });
        }
        const instruction = step['instruction'];
        if (!object(instruction)) error(`${sp}.instruction`, 'instruction', 'expected command or HTTP instruction');
        else {
          fields(instruction, ['kind', 'content'], `${sp}.instruction`);
          if (instruction['kind'] !== 'command' && instruction['kind'] !== 'http') error(`${sp}.instruction.kind`, 'instruction-kind', 'expected command or http');
          text(instruction['content'], `${sp}.instruction.content`);
        }
        const expected = step['expected'];
        if (!object(expected)) error(`${sp}.expected`, 'expected-result', 'expected a status and observable result');
        else {
          fields(expected, ['status', 'observation'], `${sp}.expected`);
          const status = expected['status'];
          const http = object(instruction) && instruction['kind'] === 'http';
          if (typeof status !== 'number' || !Number.isInteger(status) || status < (http ? 100 : 0) || status > (http ? 599 : 255)) error(`${sp}.expected.status`, 'status', http ? 'expected HTTP status 100 to 599' : 'expected command exit 0 to 255');
          text(expected['observation'], `${sp}.expected.observation`);
        }
        const grounds = step['grounds'];
        if (!Array.isArray(grounds) || grounds.length === 0 || grounds.length > 30) error(`${sp}.grounds`, 'grounds', 'expected 1 to 30 pinned source spans');
        else grounds.forEach((ground: unknown, gi: number) => {
          const gp = `${sp}.grounds[${gi}]`;
          if (!object(ground)) { error(gp, 'ground', 'expected a pinned source span'); return; }
          fields(ground, ['repository', 'commit', 'path', 'line', 'endLine'], gp);
          if (typeof ground['repository'] !== 'string' || !repositories.has(ground['repository'])) error(`${gp}.repository`, 'ground-repository', 'repository is not in the pinned context');
          else if (ground['commit'] !== repositories.get(ground['repository'])) error(`${gp}.commit`, 'ground-commit', 'ground differs from the pinned repository commit');
          if (typeof ground['path'] !== 'string' || !safeGuidePath(ground['path'])) error(`${gp}.path`, 'ground-path', 'expected a safe source path');
          const line = ground['line']; const end = ground['endLine'];
          if (typeof line !== 'number' || !Number.isInteger(line) || line < 1 || typeof end !== 'number' || !Number.isInteger(end) || end < line || end - line > 500) error(`${gp}.line`, 'ground-span', 'expected a non-empty source span of at most 501 lines');
        });
      });
    });
  }
  if (diagnostics.length > 0) return done();
  const guide = freeze(input as unknown as GuideDocument);
  const allSteps = guide.procedures.flatMap((procedure) => procedure.steps);
  if (allSteps.length > 240) error('$.procedures', 'bound', 'guide exceeds 240 total steps');
  if (allSteps.reduce((sum, step) => sum + step.grounds.length, 0) > 1200) error('$.procedures', 'bound', 'guide exceeds 1200 total grounds');
  if (allSteps.reduce((sum, step) => sum + step.inputs.length, 0) > 480) error('$.procedures', 'bound', 'guide exceeds 480 total inputs');
  try { if (!sameGuideContext(guide.context, host.expectedContext)) error('$.context', 'stale-context', 'full temporal context differs from the host context'); }
  catch { error('$.context', 'verification-unavailable', 'host temporal context is unavailable'); }
  if (typeof host.verifyStep !== 'function') error('$.procedures', 'verification-unavailable', 'host source verification is unavailable');
  if (diagnostics.length > 0) return done();
  for (const [pi, procedure] of guide.procedures.entries()) {
    for (const [si, step] of procedure.steps.entries()) {
      const path = `$.procedures[${pi}].steps[${si}]`;
      try {
        const problems = await host.verifyStep(step, procedure, guide);
        if (!Array.isArray(problems)) error(path, 'verification-unavailable', 'host did not return a source verification result');
        else if (problems.length > 0) error(path, 'unsupported-instruction', 'host evidence does not support both the exact instruction and expected result');
      } catch { error(path, 'verification-unavailable', 'host source verification failed; no checked guide was produced'); }
    }
  }
  if (diagnostics.length > 0) return done();
  checkedGuides.add(guide);
  return { ok: true, guide };
}
