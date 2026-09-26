// Fails unless a Playwright JSON report shows at least one test that ran.
// A blocking CI leg must not go green on an empty or fully skipped suite.
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'playwright-results/results.json';
let report;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.log(`::error::Playwright JSON report not readable at ${file}: ${err.message}`);
  process.exit(1);
}
const { expected = 0, unexpected = 0, flaky = 0, skipped = 0 } = report.stats ?? {};
const ran = expected + unexpected + flaky;
console.log(`Playwright ran ${ran} tests (${expected} passed, ${unexpected} failed, ${flaky} flaky, ${skipped} skipped).`);
if (ran === 0) {
  console.log('::error::The Playwright suite ran zero tests.');
  process.exit(1);
}
