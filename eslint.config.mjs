import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default defineConfig(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'reference/**',
      'test-results/**',
      'playwright-report/**',
      'build/**',
      'resources/**'
    ]
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.web.json', './tsconfig.e2e.json'],
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always']
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules
    }
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'tests/**/*.{ts,mjs}', 'scripts/**/*.mjs', '*.config.{ts,js}'],
    languageOptions: { globals: globals.node }
  },
  {
    files: ['scripts/**/*.mjs', 'tests/support/*.mjs', 'tests/fixtures/*.mjs', 'eslint.config.mjs'],
    extends: [tseslint.configs.disableTypeChecked]
  },
  {
    // Calibration/snapshot scripts evaluate callbacks inside the app's page.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  }
);
