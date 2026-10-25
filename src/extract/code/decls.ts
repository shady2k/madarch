/**
 * What a file declares that the symbol reader does not say: the types of
 * fields, parameters and results, the members of each type, what a type
 * extends or implements, and which declarations are abstract. These are the
 * parts a call through a member (`h.svc.Place(...)`) needs to be tied to the
 * method it reaches. Types are kept as the text the file writes (`Deps`,
 * `application.Service`); the program resolves them against the file's imports.
 *
 * The reading is syntactic and bounded: a type this reader cannot name (a map,
 * a function type, a generic argument it does not unwrap) has no text, and a
 * call through it is not claimed.
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { readSyntaxTree, type SyntaxTreeRead } from '../../fill/stages/syntax-extract.js';
import type { SourceFile } from './source.js';

export type TypeKind = 'class' | 'interface' | 'struct' | 'type';

export interface MemberDecl {
  readonly name: string;
  readonly kind: 'field' | 'method';
  /** The qualified name of the member's symbol (`OrderHandlers.Create`). */
  readonly qualifiedName: string;
  /** The field's type or the method's first result, as the file writes it. */
  readonly type?: string;
  readonly abstract: boolean;
}

export interface BaseDecl {
  readonly text: string;
  readonly form: 'extends' | 'implements' | 'embeds';
}

export interface TypeDecl {
  readonly name: string;
  readonly kind: TypeKind;
  readonly abstract: boolean;
  readonly members: readonly MemberDecl[];
  readonly bases: readonly BaseDecl[];
}

export interface TopDecl {
  readonly name: string;
  readonly kind: 'func' | 'var' | 'type';
  /** A function's first result type. */
  readonly returns?: string;
  /** A variable's declared (or constructed) type. */
  readonly varType?: string;
}

export interface MethodDecl {
  /** The receiver type's name (`OrderHandlers`). */
  readonly receiver: string;
  readonly member: MemberDecl;
}

export interface FileDecls {
  readonly packageName?: string;
  readonly types: readonly TypeDecl[];
  readonly tops: readonly TopDecl[];
  /** Go methods, declared apart from their type and possibly in another file of the package. */
  readonly methods: readonly MethodDecl[];
  /** The declared type text of a variable, constant or field symbol, by qualified name. */
  readonly typeText: ReadonlyMap<string, string>;
  /** The qualified names of abstract classes and abstract methods. */
  readonly abstractNames: ReadonlySet<string>;
}

const EMPTY: FileDecls = { types: [], tops: [], methods: [], typeText: new Map(), abstractNames: new Set() };

export async function readDecls(file: SourceFile): Promise<{ readonly decls: FileDecls; readonly read: boolean }> {
  const read: SyntaxTreeRead<FileDecls> = await readSyntaxTree(file.path, file.bytes, (parsed) =>
    file.language === 'go' ? goDecls(parsed.root, parsed.text) : tsDecls(parsed.root, parsed.text),
  );
  return read.read ? { decls: read.value, read: true } : { decls: EMPTY, read: false };
}

// ---- helpers ----------------------------------------------------------------

function textOf(node: SyntaxNode, text: string): string {
  return text.slice(node.startIndex, node.endIndex);
}

function named(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child): child is SyntaxNode => child !== null);
}

function fieldNodes(node: SyntaxNode, field: string): SyntaxNode[] {
  return node.childrenForFieldName(field).filter((child): child is SyntaxNode => child !== null);
}

// ---- Go -----------------------------------------------------------------------

/** The name of a Go type expression (`Deps`, `application.Service`), through pointers and generics; undefined for a map, slice or function type. */
export function goTypeName(node: SyntaxNode | null, text: string): string | undefined {
  if (node === null) return undefined;
  switch (node.type) {
    case 'type_identifier':
      return textOf(node, text);
    case 'qualified_type': {
      const pkg = node.childForFieldName('package');
      const name = node.childForFieldName('name');
      return pkg === null || name === null ? undefined : `${textOf(pkg, text)}.${textOf(name, text)}`;
    }
    case 'pointer_type':
    case 'parenthesized_type':
      return goTypeName(named(node)[0] ?? null, text);
    case 'generic_type':
      return goTypeName(node.childForFieldName('type'), text);
    default:
      return undefined;
  }
}

/** The first result type of a Go function: a single type, or the first of a parenthesized list. */
function goResult(node: SyntaxNode, text: string): string | undefined {
  const result = node.childForFieldName('result');
  if (result === null) return undefined;
  if (result.type !== 'parameter_list') return goTypeName(result, text);
  const first = named(result)[0];
  return first === undefined ? undefined : goTypeName(first.childForFieldName('type'), text);
}

function goDecls(root: SyntaxNode, text: string): FileDecls {
  let packageName: string | undefined;
  const types: TypeDecl[] = [];
  const tops: TopDecl[] = [];
  const methods: MethodDecl[] = [];
  const typeText = new Map<string, string>();
  for (const top of named(root)) {
    switch (top.type) {
      case 'package_clause': {
        const name = named(top)[0];
        if (name !== undefined) packageName = textOf(name, text);
        break;
      }
      case 'function_declaration': {
        const name = top.childForFieldName('name');
        if (name === null) break;
        const returns = goResult(top, text);
        tops.push({ name: textOf(name, text), kind: 'func', ...(returns === undefined ? {} : { returns }) });
        break;
      }
      case 'method_declaration': {
        const name = top.childForFieldName('name');
        const receiver = top.childForFieldName('receiver');
        const holder = receiver === null ? undefined : named(receiver)[0];
        const receiverType = holder === undefined ? undefined : goTypeName(holder.childForFieldName('type'), text);
        if (name === null || receiverType === undefined || receiverType.includes('.')) break;
        const returns = goResult(top, text);
        methods.push({
          receiver: receiverType,
          member: { name: textOf(name, text), kind: 'method', qualifiedName: `${receiverType}.${textOf(name, text)}`, ...(returns === undefined ? {} : { type: returns }), abstract: false },
        });
        break;
      }
      case 'type_declaration':
        for (const spec of named(top)) {
          if (spec.type !== 'type_spec' && spec.type !== 'type_alias') continue;
          const name = spec.childForFieldName('name');
          const body = spec.childForFieldName('type');
          if (name === null || body === null) continue;
          const typeName = textOf(name, text);
          tops.push({ name: typeName, kind: 'type' });
          types.push(goTypeDecl(typeName, body, text, typeText));
        }
        break;
      case 'var_declaration':
      case 'const_declaration':
        for (const spec of named(top).flatMap((child) => (child.type === 'var_spec_list' ? named(child) : [child]))) {
          if (spec.type !== 'var_spec' && spec.type !== 'const_spec') continue;
          const declaredType = goTypeName(spec.childForFieldName('type'), text);
          const typeNode = spec.childForFieldName('type');
          for (const name of fieldNodes(spec, 'name')) {
            const variable = textOf(name, text);
            tops.push({ name: variable, kind: 'var', ...(declaredType === undefined ? {} : { varType: declaredType }) });
            if (typeNode !== null) typeText.set(variable, textOf(typeNode, text));
          }
        }
        break;
      default:
        break;
    }
  }
  return { ...(packageName === undefined ? {} : { packageName }), types, tops, methods, typeText, abstractNames: new Set() };
}

function goTypeDecl(name: string, body: SyntaxNode, text: string, typeText: Map<string, string>): TypeDecl {
  const members: MemberDecl[] = [];
  const bases: BaseDecl[] = [];
  if (body.type === 'struct_type') {
    const list = named(body).find((child) => child.type === 'field_declaration_list');
    for (const field of list === undefined ? [] : named(list)) {
      if (field.type !== 'field_declaration') continue;
      const typeNode = field.childForFieldName('type');
      const fieldType = goTypeName(typeNode, text);
      const names = fieldNodes(field, 'name');
      if (names.length === 0) {
        if (fieldType !== undefined) bases.push({ text: fieldType, form: 'embeds' });
        continue;
      }
      for (const fieldName of names) {
        const member = textOf(fieldName, text);
        members.push({ name: member, kind: 'field', qualifiedName: `${name}.${member}`, ...(fieldType === undefined ? {} : { type: fieldType }), abstract: false });
        if (typeNode !== null) typeText.set(`${name}.${member}`, textOf(typeNode, text));
      }
    }
    return { name, kind: 'struct', abstract: false, members, bases };
  }
  if (body.type === 'interface_type') {
    for (const element of named(body)) {
      if (element.type !== 'method_spec' && element.type !== 'method_elem') continue;
      const method = element.childForFieldName('name');
      if (method === null) continue;
      const methodName = textOf(method, text);
      const returns = goResult(element, text);
      members.push({ name: methodName, kind: 'method', qualifiedName: `${name}.${methodName}`, ...(returns === undefined ? {} : { type: returns }), abstract: true });
    }
    return { name, kind: 'interface', abstract: false, members, bases };
  }
  return { name, kind: 'type', abstract: false, members, bases };
}

// ---- TypeScript -----------------------------------------------------------------

/** Types that wrap the type a value has once awaited or marked. */
const TRANSPARENT_GENERICS: ReadonlySet<string> = new Set(['Promise', 'Readonly', 'Required', 'NonNullable']);

/** The name of a TypeScript type (`PaymentRepository`, `Payment` for `Promise<Payment>`, `T` for `T | undefined`). */
export function tsTypeName(node: SyntaxNode | null, text: string): string | undefined {
  if (node === null) return undefined;
  switch (node.type) {
    case 'type_annotation':
    case 'parenthesized_type':
    case 'readonly_type':
      return tsTypeName(named(node)[0] ?? null, text);
    case 'type_identifier':
    case 'nested_type_identifier':
      return textOf(node, text);
    case 'generic_type': {
      const name = node.childForFieldName('name');
      if (name === null) return undefined;
      const written = textOf(name, text);
      if (!TRANSPARENT_GENERICS.has(written)) return written;
      const args = named(node).find((child) => child.type === 'type_arguments');
      return tsTypeName(args === undefined ? null : (named(args)[0] ?? null), text);
    }
    case 'union_type': {
      for (const member of named(node)) {
        const found = tsTypeName(member, text);
        if (found !== undefined && found !== 'undefined' && found !== 'null') return found;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function tsDecls(root: SyntaxNode, text: string): FileDecls {
  const types: TypeDecl[] = [];
  const tops: TopDecl[] = [];
  const typeText = new Map<string, string>();
  const abstractNames = new Set<string>();
  for (const statement of named(root)) {
    const declaration = statement.type === 'export_statement' ? statement.childForFieldName('declaration') : statement;
    if (declaration === null) continue;
    switch (declaration.type) {
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'class': {
        const name = declaration.childForFieldName('name');
        if (name === null) break;
        const className = textOf(name, text);
        tops.push({ name: className, kind: 'type' });
        types.push(tsClass(className, declaration, text, typeText, abstractNames));
        break;
      }
      case 'interface_declaration': {
        const name = declaration.childForFieldName('name');
        if (name === null) break;
        const interfaceName = textOf(name, text);
        tops.push({ name: interfaceName, kind: 'type' });
        types.push({ name: interfaceName, kind: 'interface', abstract: false, members: tsSignatures(interfaceName, declaration.childForFieldName('body'), text, typeText), bases: [] });
        break;
      }
      case 'type_alias_declaration': {
        const name = declaration.childForFieldName('name');
        if (name === null) break;
        const aliasName = textOf(name, text);
        tops.push({ name: aliasName, kind: 'type' });
        types.push({ name: aliasName, kind: 'type', abstract: false, members: tsSignatures(aliasName, declaration.childForFieldName('value'), text, typeText), bases: [] });
        break;
      }
      case 'function_declaration': {
        const name = declaration.childForFieldName('name');
        if (name === null) break;
        const returns = tsTypeName(declaration.childForFieldName('return_type'), text);
        tops.push({ name: textOf(name, text), kind: 'func', ...(returns === undefined ? {} : { returns }) });
        break;
      }
      case 'lexical_declaration':
      case 'variable_declaration':
        for (const declarator of named(declaration)) {
          if (declarator.type !== 'variable_declarator') continue;
          const name = declarator.childForFieldName('name');
          if (name === null || name.type !== 'identifier') continue;
          const variable = textOf(name, text);
          const annotation = declarator.childForFieldName('type');
          const value = declarator.childForFieldName('value');
          let varType = tsTypeName(annotation, text);
          if (varType === undefined && value !== null && value.type === 'new_expression') {
            const constructed = value.childForFieldName('constructor');
            if (constructed !== null && constructed.type === 'identifier') varType = textOf(constructed, text);
          }
          const returns = value !== null && (value.type === 'arrow_function' || value.type === 'function_expression') ? tsTypeName(value.childForFieldName('return_type'), text) : undefined;
          const isFunction = value !== null && (value.type === 'arrow_function' || value.type === 'function_expression');
          tops.push(
            isFunction
              ? { name: variable, kind: 'func', ...(returns === undefined ? {} : { returns }) }
              : { name: variable, kind: 'var', ...(varType === undefined ? {} : { varType }) },
          );
          if (annotation !== null) typeText.set(variable, textOf(annotation, text).replace(/^:\s*/, ''));
        }
        break;
      default:
        break;
    }
  }
  return { types, tops, methods: [], typeText, abstractNames };
}

function tsClass(name: string, node: SyntaxNode, text: string, typeText: Map<string, string>, abstractNames: Set<string>): TypeDecl {
  const members: MemberDecl[] = [];
  const bases: BaseDecl[] = [];
  const abstractClass = node.type === 'abstract_class_declaration';
  if (abstractClass) abstractNames.add(name);
  for (const child of named(node)) {
    if (child.type !== 'class_heritage') continue;
    for (const clause of named(child)) {
      if (clause.type === 'extends_clause') {
        for (const value of fieldNodes(clause, 'value')) {
          if (value.type === 'identifier') bases.push({ text: textOf(value, text), form: 'extends' });
        }
      } else if (clause.type === 'implements_clause') {
        for (const implemented of named(clause)) {
          const written = tsTypeName(implemented, text);
          if (written !== undefined) bases.push({ text: written, form: 'implements' });
        }
      }
    }
  }
  const body = node.childForFieldName('body');
  for (const member of body === null ? [] : named(body)) {
    switch (member.type) {
      case 'method_definition':
      case 'abstract_method_signature': {
        const methodName = member.childForFieldName('name');
        if (methodName === null) break;
        const written = textOf(methodName, text);
        const qualifiedName = `${name}.${written}`;
        const isAbstract = member.type === 'abstract_method_signature';
        if (isAbstract) abstractNames.add(qualifiedName);
        if (written === 'constructor') {
          const parameters = member.childForFieldName('parameters');
          for (const parameter of parameters === null ? [] : named(parameters)) {
            const isProperty = parameter.children.some((part) => part !== null && (part.type === 'accessibility_modifier' || part.type === 'readonly'));
            const pattern = parameter.childForFieldName('pattern');
            if (!isProperty || pattern === null || pattern.type !== 'identifier') continue;
            const propertyName = textOf(pattern, text);
            const propertyType = tsTypeName(parameter.childForFieldName('type'), text);
            members.push({ name: propertyName, kind: 'field', qualifiedName: `${name}.${propertyName}`, ...(propertyType === undefined ? {} : { type: propertyType }), abstract: false });
            const annotation = parameter.childForFieldName('type');
            if (annotation !== null) typeText.set(`${name}.${propertyName}`, textOf(annotation, text).replace(/^:\s*/, ''));
          }
          members.push({ name: written, kind: 'method', qualifiedName, abstract: false });
          break;
        }
        const returns = tsTypeName(member.childForFieldName('return_type'), text);
        members.push({ name: written, kind: 'method', qualifiedName, ...(returns === undefined ? {} : { type: returns }), abstract: isAbstract });
        break;
      }
      case 'public_field_definition': {
        const fieldName = member.childForFieldName('name');
        if (fieldName === null) break;
        const written = textOf(fieldName, text);
        const annotation = member.childForFieldName('type');
        let fieldType = tsTypeName(annotation, text);
        const value = member.childForFieldName('value');
        if (fieldType === undefined && value !== null && value.type === 'new_expression') {
          const constructed = value.childForFieldName('constructor');
          if (constructed !== null && constructed.type === 'identifier') fieldType = textOf(constructed, text);
        }
        members.push({ name: written, kind: 'field', qualifiedName: `${name}.${written}`, ...(fieldType === undefined ? {} : { type: fieldType }), abstract: false });
        if (annotation !== null) typeText.set(`${name}.${written}`, textOf(annotation, text).replace(/^:\s*/, ''));
        break;
      }
      default:
        break;
    }
  }
  return { name, kind: 'class', abstract: abstractClass, members, bases };
}

/** The members an interface body or an object type declares. */
function tsSignatures(owner: string, body: SyntaxNode | null, text: string, typeText: Map<string, string>): MemberDecl[] {
  const members: MemberDecl[] = [];
  if (body === null) return members;
  const container = body.type === 'object_type' || body.type === 'interface_body' ? body : undefined;
  for (const member of container === undefined ? [] : named(container)) {
    const memberName = member.childForFieldName('name');
    if (memberName === null) continue;
    const written = textOf(memberName, text);
    if (member.type === 'method_signature') {
      const returns = tsTypeName(member.childForFieldName('return_type'), text);
      members.push({ name: written, kind: 'method', qualifiedName: `${owner}.${written}`, ...(returns === undefined ? {} : { type: returns }), abstract: true });
    } else if (member.type === 'property_signature') {
      const annotation = member.childForFieldName('type');
      const propertyType = tsTypeName(annotation, text);
      members.push({ name: written, kind: 'field', qualifiedName: `${owner}.${written}`, ...(propertyType === undefined ? {} : { type: propertyType }), abstract: false });
      if (annotation !== null) typeText.set(`${owner}.${written}`, textOf(annotation, text).replace(/^:\s*/, ''));
    }
  }
  return members;
}
