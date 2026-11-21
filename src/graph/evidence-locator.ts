/** Evidence locators describe immutable source fragments, never graph identities. */
import {validateDeclaredJsonSchema} from './value-validation.js';
export const EVIDENCE_LOCATOR_SCHEMA={
 $schema:'https://json-schema.org/draft/2020-12/schema',type:'object',additionalProperties:false,
 properties:{
  lineStart:{type:'integer',minimum:0},lineEnd:{type:'integer',minimum:0},
  columnStart:{type:'integer',minimum:0},columnEnd:{type:'integer',minimum:0},
  start:{type:'integer',minimum:0},end:{type:'integer',minimum:0},
  digest:{type:'string',minLength:1},commit:{type:'string',minLength:1},path:{type:'string',minLength:1},
 },
} as const;
const validate=validateDeclaredJsonSchema(EVIDENCE_LOCATOR_SCHEMA);
export function validateEvidenceLocator(locator:Readonly<Record<string,unknown>>):void{
 if(!validate(locator))throw new Error(`${import.meta.path}:16: EVIDENCE_INVALID ${JSON.stringify(validate.errors)}`);
 for(const [start,end] of [['lineStart','lineEnd'],['columnStart','columnEnd'],['start','end']])if(typeof locator[start!]==='number'&&typeof locator[end!]==='number'&&(locator[start!] as number)>(locator[end!] as number))throw new Error(`${import.meta.path}:17: EVIDENCE_INVALID locator interval`);
}
