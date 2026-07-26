import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const actualArgument = process.argv.find((item) => item.startsWith('--actual='));
const environmentArgument = process.argv.find((item) => item.startsWith('--environment='));
const targetEnvironment = environmentArgument?.slice('--environment='.length);
if (!actualArgument || !['staging', 'production'].includes(targetEnvironment)) {
  throw new Error('Usage: node scripts/check-cloud-drift.mjs --environment=<staging|production> --actual=<captured-cloud.json>');
}
const expected = JSON.parse(readFileSync(resolve('config/cloud-expected.json'), 'utf8'));
const actual = JSON.parse(readFileSync(resolve(actualArgument.slice('--actual='.length)), 'utf8'));
const differences = [];

if (expected.schemaVersion !== 2 || actual.schemaVersion !== 2) {
  differences.push(`schemaVersion: expected 2 in both baseline and capture`);
}

const expectedTarget = expected[targetEnvironment];
const actualTarget = actual[targetEnvironment];
if (expectedTarget?.status !== 'configured') {
  differences.push(`${targetEnvironment}: expected baseline is not configured`);
} else if (actualTarget?.status !== 'configured') {
  differences.push(`${targetEnvironment}: actual cloud resources have not been captured/configured`);
} else {
  compare(expectedTarget, actualTarget, targetEnvironment, differences);
}

const otherEnvironment = targetEnvironment === 'staging' ? 'production' : 'staging';
if (expected[otherEnvironment]?.status === 'configured') {
  if (actual[otherEnvironment]?.status !== 'configured') {
    differences.push(`${otherEnvironment}: actual cloud resources have not been captured/configured`);
  } else {
    for (const key of expected.isolationKeys ?? []) {
      if (actualTarget?.[key] === actual[otherEnvironment]?.[key]) {
        differences.push(`${targetEnvironment}.${key}: must differ from ${otherEnvironment}`);
      }
    }
  }
}
if (differences.length) {
  process.stderr.write(`[cloud-drift] BLOCKED\n- ${differences.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`[cloud-drift] ${targetEnvironment} configuration matches the expected baseline\n`);
}

function compare(expectedValue, actualValue, path, differences) {
  if (expectedValue && typeof expectedValue === 'object' && !Array.isArray(expectedValue)) {
    for (const [key, value] of Object.entries(expectedValue)) compare(value, actualValue?.[key], `${path}.${key}`, differences);
    return;
  }
  if (actualValue === undefined || String(actualValue).startsWith('TO_BE_')) differences.push(`${path}: not captured`);
  else if (String(actualValue) !== String(expectedValue)) differences.push(`${path}: expected ${JSON.stringify(expectedValue)}, captured ${JSON.stringify(actualValue)}`);
}
