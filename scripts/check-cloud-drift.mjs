import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const actualArgument = process.argv.find((item) => item.startsWith('--actual='));
if (!actualArgument) throw new Error('Usage: node scripts/check-cloud-drift.mjs --actual=<captured-cloud.json>');
const expected = JSON.parse(readFileSync(resolve('config/cloud-expected.json'), 'utf8'));
const actual = JSON.parse(readFileSync(resolve(actualArgument.slice('--actual='.length)), 'utf8'));
const differences = [];
compare(expected.production, actual.production, 'production', differences);
if (actual.staging?.status === 'TO_BE_CONFIGURED' || expected.staging.status === 'TO_BE_CONFIGURED') {
  differences.push('staging: independent resources have not been captured/configured');
} else {
  for (const key of expected.staging.mustDifferFromProduction) {
    if (actual.staging?.[key] === actual.production?.[key]) differences.push(`staging.${key}: must differ from production`);
  }
}
if (differences.length) {
  process.stderr.write(`[cloud-drift] BLOCKED\n- ${differences.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`[cloud-drift] captured configuration matches the expected baseline\n`);
}

function compare(expectedValue, actualValue, path, differences) {
  if (expectedValue && typeof expectedValue === 'object' && !Array.isArray(expectedValue)) {
    for (const [key, value] of Object.entries(expectedValue)) compare(value, actualValue?.[key], `${path}.${key}`, differences);
    return;
  }
  if (actualValue === undefined || String(actualValue).startsWith('TO_BE_')) differences.push(`${path}: not captured`);
  else if (String(actualValue) !== String(expectedValue)) differences.push(`${path}: expected ${JSON.stringify(expectedValue)}, captured ${JSON.stringify(actualValue)}`);
}
