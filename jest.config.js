export default {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/helpers/setup.js'],
  transform: {},
  testMatch: ['**/tests/**/*.test.js'],
  // Integration tests talk to real Postgres/Mongo/Redis, which is the point:
  // mocking them would not prove the health, transaction or cache behaviour.
  testTimeout: 20000,
  verbose: true,
};
