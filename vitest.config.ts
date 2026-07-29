import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // pgconsole_oss_original/ is a vendored reference checkout of the upstream OSS repo,
    // not part of this project. Its tests cover code we deliberately don't have (license.ts).
    exclude: ['**/node_modules/**', '**/dist/**', 'pgconsole_oss_original/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
