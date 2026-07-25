import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { execFileSync } from 'node:child_process';

const binaryExtensions = new Set(['.fig', '.jpg', '.jpeg', '.otf', '.png', '.webp', '.woff2', '.zip']);
const allowedExampleValues = new Set([
  'local-dev-password',
  'replace-with-at-least-24-characters',
  'replace-with-at-least-16-characters',
  'storage-event-token-at-least-24',
  'temporary-secret-key',
  'must not be logged',
]);
const detectors = [
  { name: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'quoted-secret', pattern: /(?:password|passwd|secret(?:key)?|access[_-]?token|storage[_-]?event[_-]?token)\s*[:=]\s*["']([^"']{8,})["']/gi },
  { name: 'dotenv-secret', pattern: /^(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN)[A-Z0-9_]*)=([^\s#]{8,})\s*$/gm },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'tencent-secret-id', pattern: /\bAKID[A-Za-z0-9]{13,}\b/g },
];

let files;
try {
  files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
} catch {
  throw new Error('Secret scan requires a Git work tree so ignored files can be excluded safely.');
}

const findings = [];
for (const file of files) {
  if (binaryExtensions.has(extname(file).toLowerCase())) continue;
  const source = await readFile(file, 'utf8');
  for (const detector of detectors) {
    detector.pattern.lastIndex = 0;
    for (const match of source.matchAll(detector.pattern)) {
      const value = match[1];
      if (value && allowedExampleValues.has(value)) continue;
      if (value && /(^|[-_])(test|fake|example|mock|local|dummy)([-_]|$)/i.test(value) && /(?:^|\/)(?:tests?|fixtures?)(?:\/|$)/.test(file)) continue;
      const line = source.slice(0, match.index).split('\n').length;
      findings.push({ file, line, detector: detector.name });
    }
  }
}

if (findings.length > 0) {
  console.error('[secret-scan] possible secrets found (values intentionally hidden):');
  for (const finding of findings) console.error(`- ${finding.file}:${finding.line} (${finding.detector})`);
  process.exitCode = 1;
} else {
  console.log(`[secret-scan] passed (${files.length} tracked/unignored files scanned)`);
}
