import { posix } from 'node:path';
import protobuf from 'protobufjs';
import { byCodePoint } from '../model/order.js';
import { ContractReadError } from './contract-document.js';

export type ProtoField = { name: string; type: string; id: number; rule: string; oneof?: string };
export type ProtoMessage = { name: string; fields: ProtoField[]; values?: {name: string; id: number}[] };
export type ProtoDocumentation = { services: { name: string; methods: {name: string; request: string; response: string; requestStream: boolean; responseStream: boolean}[] }[]; messages: ProtoMessage[] };

/** The standard protobuf parser supplies the grammar and type resolution; no regex-shaped documentation. */
export async function protoDocument(path: string, read: (path: string) => Promise<string | undefined>, fullPath: (path: string) => string): Promise<{protobuf: ProtoDocumentation; text: string}> {
  const root = new protobuf.Root();
  const loaded = new Set<string>();
  const texts = new Map<string, string>();
  let bytes = 0;
  const refuse = (file: string, code: string, detail: string, line = 1): never => { throw new ContractReadError({path: file, line, fullPath: fullPath(file), code, detail}); };
  async function load(file: string, depth: number): Promise<void> {
    if (loaded.has(file)) return;
    if (loaded.size >= 64 || depth > 32) refuse(file, 'limit', 'protobuf imports exceed 64 files or 32 levels');
    const text = await read(file);
    if (text === undefined) refuse(file, 'missing', 'protobuf import is not readable at the pinned revision');
    const held = text!;
    bytes += Buffer.byteLength(held);
    if (bytes > 4 * 1024 * 1024) refuse(file, 'limit', 'protobuf definitions exceed the 4 MiB documentation budget');
    loaded.add(file); texts.set(file, held);
    let parsed: protobuf.IParserResult;
    try { parsed = protobuf.parse(held, root, {keepCase: true}); }
    catch (error) {
      const detail = String(error);
      refuse(file, 'parse', detail, Number(/line (\d+)/u.exec(detail)?.[1] ?? 1));
    }
    for (const dependency of [...(parsed!.imports ?? []), ...(parsed!.weakImports ?? [])].sort(byCodePoint)) {
      const line = held.slice(0, held.indexOf(dependency)).split('\n').length;
      if (/^[a-z][a-z0-9+.-]*:|^[/\\]/iu.test(dependency) || dependency.includes('\\')) refuse(file, 'reference', `invalid protobuf import: ${dependency}`, line);
      const target = posix.normalize(posix.join(posix.dirname(file), dependency));
      if (target === '..' || target.startsWith('../')) refuse(file, 'reference', `protobuf import leaves the repository: ${dependency}`, line);
      await load(target, depth + 1);
    }
  }
  await load(path, 0);
  try { root.resolveAll(); } catch (error) { refuse(path, 'reference', String(error)); }
  const result: ProtoDocumentation = {services: [], messages: []};
  function walk(namespace: protobuf.NamespaceBase): void {
    for (const member of [...namespace.nestedArray].sort((a, b) => byCodePoint(a.fullName, b.fullName))) {
      if (member instanceof protobuf.Service) result.services.push({ name: member.fullName.replace(/^\./u, ''), methods: member.methodsArray.map((method) => ({name: method.name, request: method.resolvedRequestType!.fullName.replace(/^\./u, ''), response: method.resolvedResponseType!.fullName.replace(/^\./u, ''), requestStream: method.requestStream === true, responseStream: method.responseStream === true})) });
      if (member instanceof protobuf.Type) result.messages.push({name: member.fullName.replace(/^\./u, ''), fields: member.fieldsArray.map((field) => ({name: field.name, id: field.id, type: field instanceof protobuf.MapField ? `map<${field.keyType}, ${field.resolvedType?.fullName.replace(/^\./u, '') ?? field.type}>` : field.resolvedType?.fullName.replace(/^\./u, '') ?? field.type, rule: field.repeated ? 'repeated' : field.required ? 'required' : 'optional', ...(field.partOf == null ? {} : {oneof: field.partOf.name})}))});
      if (member instanceof protobuf.Enum) result.messages.push({name: member.fullName.replace(/^\./u, ''), fields: [], values: Object.entries(member.values).map(([name, id]) => ({name, id}))});
      if (member instanceof protobuf.Namespace) walk(member);
    }
  }
  walk(root);
  return {protobuf: result, text: texts.get(path)!};
}
