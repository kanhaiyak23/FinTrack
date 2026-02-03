// Test runs are noisy enough without request logs. An explicit LOG_LEVEL still wins,
// so a failing test can be re-run with LOG_LEVEL=debug to see what happened.
process.env.LOG_LEVEL ??= 'silent';
process.env.NODE_ENV ??= 'test';
