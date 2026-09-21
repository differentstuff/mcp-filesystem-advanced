import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/__tests__/**/*.test.ts'],
    // Never scan .kilo/ (Agent Manager worktrees are gitignored local state);
    // also keep node_modules/dist out explicitly.
    exclude: ['**/.kilo/**', '**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      include: ['**/*.ts'],
      exclude: ['**/__tests__/**', '**/dist/**'],
    },
  },
});
