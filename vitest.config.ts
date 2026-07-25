import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['server/**', 'cloudfunctions/**', 'node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/types/**'],
      thresholds: { statements: 25, branches: 20, functions: 25, lines: 25 },
    },
  },
});
