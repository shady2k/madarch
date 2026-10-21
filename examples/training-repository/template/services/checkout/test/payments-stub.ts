import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'node:path';

/** Loads the Payments service definition so the test can serve it with a stub implementation. */
export function loadServiceDefinition(): grpc.ServiceDefinition {
  const definition = protoLoader.loadSync(path.resolve(__dirname, '../../../contracts/proto/payments.proto'), {
    keepCase: false,
    longs: Number,
    defaults: true,
  });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    payments: { v1: { Payments: grpc.ServiceClientConstructor } };
  };
  return loaded.payments.v1.Payments.service;
}
