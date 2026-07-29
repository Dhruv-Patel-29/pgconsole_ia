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
  // Compile-time constants that scripts/build-server.mjs and vite inject. Without them any
  // test that imports server/index.ts dies on an undefined identifier when it logs.
  define: {
    __APP_VERSION__: JSON.stringify('test'),
    __DEV__: 'false',
    __GIT_COMMIT__: JSON.stringify('test'),
  },
})
