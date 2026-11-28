# Run the repository architecture test as a required slow file

Change: madarch-x9a7.12
Base: 3d571e96b9ade9ffa28f8fc747a17bbd5c92549f
Tasks: madarch-x9a7.12
Kind: no-behavior

## Intent

GitHub CI run 46085362733 measured `test/architecture-repository.test.ts` at 31,354 ms in shard 1 and 33,971 ms in its standalone confirmation. Its single case passed both times and the shard duration guard blocked the suite.

## Rationale

The test scans the real repository to verify its architecture rules and recorded baseline. Run the full file in the existing required slow-files matrix and record the completed standalone timing. The stable test aggregate includes the matrix in its required dependencies.

## Out of scope

The architecture rules, recorded architecture violations, test assertions, timeout and shard duration limit.

## Changes to requirements

None.

## Preserved contracts

- server/store: the repository-wide architecture check over the store boundary remains part of the required GitHub test suite.

## Coverage

- server/store: test

## Where it is seen

Kind: internal
Place: the GitHub Actions test workflow
Reason: the test placement changes while the test and architecture rules stay the same.

1. Run CI for the pull request and check that the required slow-files matrix runs `test/architecture-repository.test.ts` as a single file with one passing case.
2. Check that the normal shards omit this file and the stable test aggregate requires the matrix result.

## Blocking questions

None.
