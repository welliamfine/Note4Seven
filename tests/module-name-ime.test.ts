import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('module name IME input', () => {
  it.each([
    'src/pages/home/index.wxml',
    'src/subpackages/module-settings/index.wxml',
  ])('does not truncate composition text in %s', (relativePath) => {
    const source = readSource(relativePath);
    const moduleNameInput = source.match(/<input\b[^>]*(?:class="text-input"|bindinput="onName")[^>]*\/>/)?.[0];

    expect(moduleNameInput).toBeDefined();
    expect(moduleNameInput).toContain('maxlength="-1"');
    expect(moduleNameInput).not.toContain('maxlength="10"');
  });

  it.each([
    ['src/pages/home/index.ts', 'name.length > MODULE_NAME_MAX_LENGTH'],
    ['src/subpackages/module-settings/index.ts', 'name.length > MODULE_NAME_MAX_LENGTH'],
  ])('keeps the final ten-character validation in %s', (relativePath, validation) => {
    expect(readSource(relativePath)).toContain(validation);
  });
});
