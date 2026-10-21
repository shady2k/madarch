/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { rootDir: '.', strict: true, esModuleInterop: true, skipLibCheck: true } }],
  },
};
