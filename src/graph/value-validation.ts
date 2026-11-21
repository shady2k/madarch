/** Shared offline value validation for admission and every writer (0039 items 3,4,29). */
import type { ValidateFunction } from 'ajv/dist/2020.js';
import type { FieldContract, GraphContract } from './contract.js';
import { checkValueTypes, compileValueSchema, fitsValueSchema, JSON_DIALECT, type JsonSchema, type ValueTypes } from './value-types.js';

export function closedSchema(schema:unknown,path:string):void{
 if(schema===false)return;
 if(schema===true||schema===null||typeof schema!=='object'||Array.isArray(schema))throw new Error(`${import.meta.path}:10: SCHEMA_INVALID unconstrained JSON schema at ${path}`);
 const node=schema as Record<string,unknown>;
 const properties=node.properties as Record<string,Record<string,unknown>>|undefined;
 if(properties?.key?.type==='object'&&properties.kind!==undefined&&(properties.kind.type==='string'||typeof properties.kind.const==='string'))throw new Error(`${import.meta.path}:12: SCHEMA_INVALID entity identity belongs in graph references, not JSON values at ${path}`);

 if(node.type==='object'&&node.additionalProperties===undefined&&node.unevaluatedProperties!==false)throw new Error(`${import.meta.path}:12: SCHEMA_INVALID object must declare additionalProperties or unevaluatedProperties:false at ${path}`);
 for(const name of ['additionalProperties','unevaluatedProperties','items','contains','not','if','then','else'])if(node[name]!==undefined&&node[name]!==false)closedSchema(node[name],`${path}/${name}`);
 for(const name of ['properties','patternProperties','$defs','dependentSchemas'])if(node[name]!==undefined)for(const [key,value] of Object.entries(node[name] as Record<string,unknown>))closedSchema(value,`${path}/${name}/${key}`);
 for(const name of ['allOf','anyOf','oneOf','prefixItems'])if(Array.isArray(node[name]))for(const [index,value] of node[name].entries())closedSchema(value,`${path}/${name}/${index}`);
 if(!['type','$ref','allOf','anyOf','oneOf','const','enum'].some(name=>node[name]!==undefined))throw new Error(`${import.meta.path}:16: SCHEMA_INVALID unconstrained JSON value at ${path}`);
}

export function validateDeclaredJsonSchema(schema: JsonSchema, valueTypes: ValueTypes = {}): ValidateFunction {
  if (schema.$schema !== JSON_DIALECT) throw new Error(`${import.meta.path}:8: SCHEMA_INVALID requires Draft 2020-12 JSON Schema`);
  closedSchema(schema, 'schema');
  return compileValueSchema(schema, valueTypes);
}

/** Installation and writes resolve exactly the same catalogue registry. */
export function validateValueContracts(contract: GraphContract): void {
  const types = contract.valueTypes ?? {};
  checkValueTypes(types);
  for (const kind of [...contract.vertex, ...contract.edge, ...contract.dictionary]) {
    if ((kind.checks?.length ?? 0) > 0 || (kind.indexes?.length ?? 0) > 0) throw new Error(`${import.meta.path}:17: UNSUPPORTED_CONTRACT raw SQL constraints refer to retired row storage`);
    for (const field of kind.fields) {
      if (field.valueType !== undefined && (types[field.valueType] === undefined || types[field.valueType]!.storage !== field.type)) throw new Error(`${import.meta.path}:19: SCHEMA_INVALID unknown or mismatched value type ${kind.name}.${field.name}`);
      if (field.type === 'json' && field.schema === undefined) throw new Error(`${import.meta.path}:20: SCHEMA_INVALID ${kind.name}.${field.name} requires Draft 2020-12 JSON Schema`);
      if (field.schema !== undefined) validateDeclaredJsonSchema(field.schema, types);
    }
  }
 for(const vertex of contract.vertex)if(vertex.evidence){
  const metadata=vertex.evidence;
  if(metadata.immutable!==true||Object.keys(metadata).some(key=>!['immutable','digestField','contentField','digestAlgorithm'].includes(key)))throw new Error(`${import.meta.path}:50: SCHEMA_INVALID evidence descriptor`);
  for(const name of [metadata.digestField,metadata.contentField])if(name!==undefined&&!vertex.fields.some(field=>field.name===name&&field.type==='text'))throw new Error(`${import.meta.path}:51: SCHEMA_INVALID evidence field must be declared text ${vertex.name}.${name}`);
  if(metadata.contentField!==undefined?(metadata.digestField===undefined||metadata.digestAlgorithm!=='sha256'):metadata.digestAlgorithm!==undefined)throw new Error(`${import.meta.path}:52: SCHEMA_INVALID evidence content requires explicit sha256 digest algorithm and field; algorithm without content is forbidden`);
  if(metadata.digestField!==undefined&&!vertex.key.includes(metadata.digestField))throw new Error(`${import.meta.path}:52: SCHEMA_INVALID evidence digest must be scalar key`);
 }

}

/** Nullability and physical scalar types are checked by the writer before this shared constraint check. */
export function validateFieldValue(contract: GraphContract, field: FieldContract, value: unknown): void {
  if (value === null && field.nullable === true) return;
  const types = contract.valueTypes ?? {};
  const declared = field.valueType === undefined ? undefined : types[field.valueType];
  if ((declared !== undefined && !fitsValueSchema(declared.schema, types, value)) || (field.schema !== undefined && !fitsValueSchema(field.schema, types, value))) throw new Error(`${import.meta.path}:41: VALUE_TYPE_MISMATCH ${field.name}: expected ${field.valueType ?? field.type}, received ${JSON.stringify(value)}`);
}
