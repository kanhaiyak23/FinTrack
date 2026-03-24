export default {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/helpers/setup.js'],
  transform: {},
  testMatch: ['**/tests/**/*.test.js'],
  // Integration tests talk to real Postgres/Mongo/Redis, which is the point:
  // mocking them would not prove the health, transaction or cache behaviour.
  testTimeout: 20000,
  // Every integration suite shares one Postgres and one Redis, and several of them
  // truncate. Run them one at a time: in parallel, one suite's TRUNCATE lands in the
  // middle of another's test and the failure looks like a bug in the code under test.
  maxWorkers: 1,
  verbose: true,
};
