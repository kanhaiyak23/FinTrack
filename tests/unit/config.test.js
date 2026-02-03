import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const configEntry = path.join(repoRoot, 'apps/api/src/config/index.js');

// The config module calls process.exit on invalid input, so it is exercised as a
// subprocess rather than imported. A bad environment must stop the process, not
// produce a half-configured app.
const runWith = (overrides) => {
  // ENV_FILE points at a path that does not exist so the repo's real .env cannot
  // silently satisfy a variable the test is trying to remove.
  const env = { ...process.env, ENV_FILE: path.join(repoRoot, '.env.does-not-exist') };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  try {
    execFileSync(process.execPath, [configEntry], {
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { code: 0, stderr: '' };
  } catch (err) {
    return { code: err.status, stderr: err.stderr ?? '' };
  }
};

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  MONGODB_URL: 'mongodb://localhost:27017',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a'.repeat(32),
};

describe('environment configuration', () => {
  test('accepts a complete environment', () => {
    expect(runWith(base).code).toBe(0);
  });

  test('refuses to start without JWT_SECRET', () => {
    const { code, stderr } = runWith({ ...base, JWT_SECRET: undefined });
    expect(code).toBe(1);
    expect(stderr).toMatch(/JWT_SECRET/);
  });

  test('refuses a JWT_SECRET shorter than 32 characters', () => {
    const { code, stderr } = runWith({ ...base, JWT_SECRET: 'short' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/at least 32 characters/);
  });

  test('refuses to start without DATABASE_URL', () => {
    const { code, stderr } = runWith({ ...base, DATABASE_URL: undefined });
    expect(code).toBe(1);
    expect(stderr).toMatch(/DATABASE_URL/);
  });
});
