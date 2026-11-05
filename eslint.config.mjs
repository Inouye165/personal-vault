import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'build/**', 'coverage/**', 'node_modules/**', '**/*.tsbuildinfo']
  },

  // Recommended rules for every linted file (JS, MJS, TS, TSX).
  js.configs.recommended,

  // TypeScript sources and tests: type-aware parsing is not needed for the recommended set.
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}']
  })),

  // Main process, preload, shared code, and Node-side configuration/tests.
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'src/shared/**/*.ts',
      'tests/main/**/*.ts',
      'tests/preload/**/*.ts',
      'tests/shared/**/*.ts',
      '*.config.ts'
    ],
    languageOptions: { globals: globals.node }
  },

  // Renderer: browser globals and React Hooks rules.
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/renderer/**/*.{ts,tsx}', 'tests/setup.ts'],
    languageOptions: { globals: globals.browser },
    ...reactHooks.configs.flat.recommended
  },

  // Node scripts. Smoke script also evaluates code inside the page, so it uses browser globals too.
  {
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  }
)
