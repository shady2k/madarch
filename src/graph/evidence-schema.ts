/** Graph transport evidence, distinct from the plugin wire's flat evidence envelope. */
import {Type} from 'typebox';
import {EVIDENCE_LOCATOR_SCHEMA} from './evidence-locator.js';
const GraphEntityReferenceSchema=Type.Cyclic({
 Entity:Type.Object({kind:Type.String({minLength:1}),key:Type.Record(Type.String(),Type.Union([Type.String(),Type.Number(),Type.Boolean()])),uid:Type.Optional(Type.String()),keyEdges:Type.Optional(Type.Record(Type.String({minLength:1}),Type.Ref('Entity')))},{additionalProperties:false}),
},'Entity');
export const GraphEvidenceEntrySchema=Type.Object({target:GraphEntityReferenceSchema,relation:Type.Optional(Type.String()),locator:Type.Optional(Type.Unsafe<Record<string,unknown>>(EVIDENCE_LOCATOR_SCHEMA))},{additionalProperties:false});
