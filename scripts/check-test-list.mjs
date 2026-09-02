/**
 * Fails if a test file exists that the `test` script does not name.
 *
 * The test script lists its files explicitly rather than globbing, because on
 * Node 20 (what CI pins) neither form works: `tsx --test test/` finds nothing
 * because the directory scan does not match `.ts`, and a quoted `'test/*.ts'`
 * is never expanded. Shell globbing would work on CI's ubuntu runner but not
 * through npm on Windows, so the explicit list is the portable answer.
 *
 * The cost of that list is silence: drop a new test file in and the suite still
 * exits 0, green, having never run it. That is the worst way to be wrong, so
 * this asserts the list is complete.
 */
import { readdirSync, readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const testScript = packageJson.scripts?.test ?? '';

const testFiles = readdirSync(new URL('../test', import.meta.url))
  .filter((name) => name.endsWith('.test.ts'))
  .sort();

const missing = testFiles.filter((name) => !testScript.includes('test/' + name));

if (missing.length > 0) {
  console.error('These test files are not in the "test" script, so they never run:\n');
  for (const name of missing) console.error('  test/' + name);
  console.error('\nAdd them to the "test" script in package.json.');
  process.exit(1);
}

console.log(`test script covers all ${testFiles.length} test file(s)`);
