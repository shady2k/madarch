import {expect,test} from 'bun:test';
import {validateValueContracts,validateFieldValue} from '../src/graph/value-validation.js';
import type {FieldContract,GraphContract} from '../src/graph/contract.js';
const dialect='https://json-schema.org/draft/2020-12/schema';
const field:FieldContract={name:'config',type:'json',schema:{$schema:dialect,type:'object',properties:{address:{$ref:'urn:fixture:address:v1'}},required:['address'],unevaluatedProperties:false}};
const contract:GraphContract={vertex:[{name:'fixture',table:'fixture',key:[],fields:[field],capability:'fixture'}],edge:[],dictionary:[],valueTypes:{address:{storage:'text',schema:{$schema:dialect,$id:'urn:fixture:address:v1',type:'string',format:'ipv4'}}}};
test('0039.3,4,29 installed shared schemas validate JSON with asserted formats and closed objects',()=>{
 expect(()=>validateFieldValue(contract,field,{address:'127.0.0.1'})).not.toThrow();
 expect(()=>validateFieldValue(contract,field,{address:'invalid'})).toThrow('VALUE_TYPE_MISMATCH');
 expect(()=>validateFieldValue(contract,field,{address:'127.0.0.1',extra:true})).toThrow('VALUE_TYPE_MISMATCH');
 expect(()=>validateFieldValue(contract,field,{})).toThrow('VALUE_TYPE_MISMATCH');
});
test('0039.4 installation refuses missing JSON schemas and unresolved external refs',()=>{
 expect(()=>validateValueContracts({...contract,vertex:[{...contract.vertex[0]!,fields:[{name:'config',type:'json'}]}]})).toThrow('requires Draft 2020-12');
 expect(()=>validateValueContracts({...contract,valueTypes:{}})).toThrow();
 expect(()=>validateValueContracts({...contract,valueTypes:{address:{storage:'text',schema:{$schema:dialect,$id:'urn:fixture:address:v1',type:'string',unknownVocabulary:true}}}})).toThrow();
});

test('0039.31 immutable evidence descriptors require declared text digest keys',()=>{
 const vertex={...contract.vertex[0]!,evidence:{immutable:true as const,digestField:'config'}};
 expect(()=>validateValueContracts({...contract,vertex:[vertex]})).toThrow('evidence field must be declared text');
});

test('0039.31 content proof requires an explicit supported algorithm and digest key',()=>{
 const vertex={name:'snapshot',table:'snapshot',key:['digest'],fields:[{name:'digest',type:'text' as const},{name:'content',type:'text' as const}],capability:'fixture',evidence:{immutable:true as const,digestField:'digest',contentField:'content'}};
 expect(()=>validateValueContracts({vertex:[vertex],edge:[],dictionary:[]})).toThrow('explicit sha256');
 expect(()=>validateValueContracts({vertex:[{...vertex,evidence:{...vertex.evidence,digestAlgorithm:'sha256'}}],edge:[],dictionary:[]})).not.toThrow();
 expect(()=>validateValueContracts({vertex:[{...vertex,evidence:{immutable:true,digestField:'digest',digestAlgorithm:'sha256'}}],edge:[],dictionary:[]})).toThrow('algorithm without content');
});

test('typed assertion storage refuses retired per-kind row SQL configuration',()=>{
 for(const extra of [{checks:['length(config)>0']},{indexes:[{name:'lookup',columns:['config']}]}])expect(()=>validateValueContracts({...contract,vertex:[{...contract.vertex[0]!,...extra}]})).toThrow('UNSUPPORTED_CONTRACT');
});

test('0039.4 JSON cannot hide unconstrained values or entity identities',()=>{
 for(const schema of [
  {$schema:dialect,type:'object'},
  {$schema:dialect,type:'array',items:{}},
  {$schema:dialect,type:'object',properties:{key:{type:'object',additionalProperties:{type:'string'}},kind:{type:'string'}},additionalProperties:false},
 ]) expect(()=>validateValueContracts({...contract,vertex:[{...contract.vertex[0]!,fields:[{...field,schema}]}]})).toThrow('SCHEMA_INVALID');
});
