/** Closed gRPC deadline selectors. Values describe syntax; none executes source. */
import {createHash} from 'node:crypto';
import source from './grpc-deadline-models.json' with {type: 'text'};

export interface GrpcDeadlineModel {
  readonly schemaVersion: 1;
  readonly package: '@grpc/grpc-js';
  readonly reference: string;
  readonly optionsArgument: number;
  readonly deadlineProperty: string;
  readonly dateConstructor: string;
  readonly clockMember: string;
  readonly numberConversion: string;
}

export function validateGrpcDeadlineModel(value: unknown): GrpcDeadlineModel {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('grpc-deadline-models: expected object');
  const record = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'package', 'reference', 'optionsArgument', 'deadlineProperty', 'dateConstructor', 'clockMember', 'numberConversion'];
  if (Object.keys(record).length !== keys.length || Object.keys(record).some(key => !keys.includes(key))) throw new Error('grpc-deadline-models: unexpected fields');
  if (record.schemaVersion !== 1 || record.package !== '@grpc/grpc-js' || record.reference !== 'https://www.npmjs.com/package/@grpc/grpc-js') throw new Error('grpc-deadline-models: unsupported identity');
  if (record.optionsArgument !== 1 || record.deadlineProperty !== 'deadline' || record.dateConstructor !== 'Date' || record.clockMember !== 'now' || record.numberConversion !== 'Number') throw new Error('grpc-deadline-models: unsupported selector');
  return Object.freeze({...record}) as unknown as GrpcDeadlineModel;
}

export const grpcDeadlineModel = validateGrpcDeadlineModel(JSON.parse(source as unknown as string));
export const grpcDeadlineModelDigest = createHash('sha256').update(JSON.stringify(grpcDeadlineModel)).digest('hex');
