# Payments service

Charges and refunds. HTTP on 8081 (`/payments`, `/reports`, `/healthz`), gRPC on
50051 (contracts/proto/payments.proto). The provider is chosen by
`PAYMENT_PROVIDER` (`cardnet` or `deferred`); a provider call that does not
answer within `PAYMENT_TIMEOUT_MS` is retried and then declined.

`npm test` runs the jest tests; `npx prisma generate` creates the database client
that the code imports from `@prisma/client`.
