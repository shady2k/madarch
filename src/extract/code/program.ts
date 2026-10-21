/**
 * The repository's declarations side by side: for each type its members and
 * bases, for each Go package or TypeScript file the names it declares at the
 * top, and for each file what its imports bind. With these a type text written
 * in one file (`application.Service`, `PaymentRepository`) is tied to the type
 * it names, and a member of that type to the symbol that declares it.
 *
 * Scopes: a Go package is its folder (every file of the folder shares the
 * names), a TypeScript file is its own. A type's id is the scope and its name,
 * `<scope>#<name>`, so a Go method declared in another file of the package
 * lands on the same type as its struct.
 */
import type { FileDecls, TypeKind } from './decls.js';
import { folderOf, type CodeLanguage, type FileRole } from './source.js';

/** What an import binds in a file. */
export type Binding =
  | { readonly kind: 'package'; readonly scope: string }
  | { readonly kind: 'named'; readonly file: string; readonly name: string }
  | { readonly kind: 'default'; readonly file: string }
  | { readonly kind: 'namespace'; readonly file: string };

export interface FileCtx {
  readonly path: string;
  readonly language: CodeLanguage;
  readonly role: FileRole;
  readonly scope: string;
  /** The folder of the nearest go.mod, for Go files: interfaces are satisfied inside one module. */
  readonly goRoot: string | undefined;
  readonly imports: ReadonlyMap<string, Binding>;
  readonly decls: FileDecls;
}

export interface MemberInfo {
  readonly name: string;
  readonly kind: 'field' | 'method';
  readonly qualifiedName: string;
  /** The file whose symbol declares the member. */
  readonly file: string;
  readonly type?: string;
  readonly abstract: boolean;
}

export interface BaseInfo {
  readonly text: string;
  readonly form: 'extends' | 'implements' | 'embeds';
  readonly file: string;
}

export interface TypeInfo {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly scope: string;
  readonly kind: TypeKind;
  readonly abstract: boolean;
  readonly goRoot: string | undefined;
  readonly role: FileRole;
  readonly members: Map<string, MemberInfo>;
  readonly bases: BaseInfo[];
}

export interface TopInfo {
  readonly name: string;
  readonly kind: 'func' | 'var' | 'type';
  readonly file: string;
  readonly returns?: string;
  readonly varType?: string;
}

/** What an expression is: a value of a type, or a scope whose top-level names it can reach (`pkg.`, `ns.`). */
export type Ty = { readonly t: 'type'; readonly id: string } | { readonly t: 'scope'; readonly scope: string };

export interface Implementation {
  readonly impl: TypeInfo;
  readonly iface: TypeInfo;
  readonly form: 'declared' | 'structural';
}

export class Program {
  readonly files = new Map<string, FileCtx>();
  readonly types = new Map<string, TypeInfo>();
  readonly tops = new Map<string, Map<string, TopInfo>>();
  private implementationList: Implementation[] | undefined;

  constructor(contexts: readonly FileCtx[]) {
    for (const ctx of contexts) this.files.set(ctx.path, ctx);
    for (const ctx of contexts) {
      const scopeTops = this.tops.get(ctx.scope) ?? new Map<string, TopInfo>();
      this.tops.set(ctx.scope, scopeTops);
      for (const top of ctx.decls.tops) {
        if (!scopeTops.has(top.name)) scopeTops.set(top.name, { ...top, file: ctx.path });
      }
      for (const type of ctx.decls.types) {
        const id = `${ctx.scope}#${type.name}`;
        if (this.types.has(id)) continue;
        const members = new Map<string, MemberInfo>();
        for (const member of type.members) members.set(member.name, { ...member, file: ctx.path });
        this.types.set(id, {
          id,
          name: type.name,
          file: ctx.path,
          scope: ctx.scope,
          kind: type.kind,
          abstract: type.abstract,
          goRoot: ctx.goRoot,
          role: ctx.role,
          members,
          bases: type.bases.map((base) => ({ ...base, file: ctx.path })),
        });
      }
    }
    for (const ctx of contexts) {
      for (const method of ctx.decls.methods) {
        const owner = this.types.get(`${ctx.scope}#${method.receiver}`);
        if (owner === undefined || owner.members.has(method.member.name)) continue;
        owner.members.set(method.member.name, { ...method.member, file: ctx.path });
      }
    }
  }

  /** The id of the type a text written in a file names, or undefined where the text names no type of this repository. */
  resolveTypeText(text: string | undefined, file: string): string | undefined {
    if (text === undefined) return undefined;
    const ctx = this.files.get(file);
    if (ctx === undefined) return undefined;
    const dot = text.indexOf('.');
    if (dot >= 0) {
      const binding = ctx.imports.get(text.slice(0, dot));
      const name = text.slice(dot + 1);
      if (binding === undefined) return undefined;
      if (binding.kind === 'package') return this.hasType(`${binding.scope}#${name}`);
      if (binding.kind === 'namespace') return this.hasType(`${binding.file}#${name}`);
      return undefined;
    }
    const local = this.hasType(`${ctx.scope}#${text}`);
    if (local !== undefined) return local;
    const binding = ctx.imports.get(text);
    if (binding === undefined) return undefined;
    if (binding.kind === 'named') return this.hasType(`${binding.file}#${binding.name}`);
    if (binding.kind === 'default') return this.hasType(`${binding.file}#default`);
    return undefined;
  }

  private hasType(id: string): string | undefined {
    return this.types.has(id) ? id : undefined;
  }

  /** The member a type (or what it extends or embeds) declares by this name. */
  findMember(typeId: string, name: string, seen: Set<string> = new Set()): { readonly owner: TypeInfo; readonly member: MemberInfo } | undefined {
    if (seen.has(typeId)) return undefined;
    seen.add(typeId);
    const type = this.types.get(typeId);
    if (type === undefined) return undefined;
    const own = type.members.get(name);
    if (own !== undefined) return { owner: type, member: own };
    for (const base of type.bases) {
      if (base.form === 'implements') continue;
      const baseId = this.resolveTypeText(base.text, base.file);
      if (baseId === undefined) continue;
      const found = this.findMember(baseId, name, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** The top-level name of a scope, if the scope declares it. */
  top(scope: string, name: string): TopInfo | undefined {
    return this.tops.get(scope)?.get(name);
  }

  /**
   * Every type that implements an interface of the repository. A class that
   * names the interface in an `implements` clause implements it by declaration;
   * a Go type implements the interfaces whose method names its method set
   * holds, which is how Go satisfies an interface (no declaration names the
   * link), within one module.
   */
  implementations(): readonly Implementation[] {
    if (this.implementationList !== undefined) return this.implementationList;
    const found: Implementation[] = [];
    const ids = [...this.types.keys()].sort();
    for (const id of ids) {
      const type = this.types.get(id)!;
      if (type.kind === 'class') {
        for (const base of type.bases) {
          if (base.form !== 'implements') continue;
          const target = this.resolveTypeText(base.text, base.file);
          const iface = target === undefined ? undefined : this.types.get(target);
          if (iface !== undefined && iface.kind === 'interface') found.push({ impl: type, iface, form: 'declared' });
        }
      }
    }
    for (const ifaceId of ids) {
      const iface = this.types.get(ifaceId)!;
      if (iface.kind !== 'interface' || iface.goRoot === undefined) continue;
      const methods = [...iface.members.values()].filter((member) => member.kind === 'method').map((member) => member.name);
      if (methods.length === 0) continue;
      for (const id of ids) {
        const candidate = this.types.get(id)!;
        if (candidate.goRoot !== iface.goRoot || (candidate.kind !== 'struct' && candidate.kind !== 'type') || candidate.id === iface.id) continue;
        if (methods.every((name) => this.findMember(candidate.id, name)?.member.kind === 'method')) found.push({ impl: candidate, iface, form: 'structural' });
      }
    }
    this.implementationList = found;
    return found;
  }

  /** The types that implement an interface, tests' fakes left out: a fake is not a way the code reaches. */
  implementorsOf(ifaceId: string): TypeInfo[] {
    return this.implementations()
      .filter((entry) => entry.iface.id === ifaceId && entry.impl.role === 'code')
      .map((entry) => entry.impl);
  }
}

/** Resolves a Go import path to the repository folder it names, or undefined for a package outside the repository. */
export function goImportFolder(specifier: string, modules: readonly { readonly folder: string; readonly module: string }[], folders: ReadonlySet<string>): string | undefined {
  let best: { readonly folder: string; readonly module: string } | undefined;
  for (const candidate of modules) {
    if (specifier !== candidate.module && !specifier.startsWith(`${candidate.module}/`)) continue;
    if (best === undefined || candidate.module.length > best.module.length) best = candidate;
  }
  if (best === undefined) return undefined;
  const rest = specifier.slice(best.module.length + 1);
  const target = best.folder === '' ? rest : rest === '' ? best.folder : `${best.folder}/${rest}`;
  return folders.has(target) ? target : undefined;
}

export { folderOf };
