// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const handlePattern = {
  group: ['**/access/handles.ts', '**/access/compile.ts'],
  allowTypeImports: true,
  message: 'Authorized handles come from the access service only.',
}

const optionalModulePattern = {
  group: ['**/public-api/**', '**/imports/**', '**/mcp/**'],
  message: 'The core never imports from optional modules; wire them in the composition root.',
}

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: [
          './apps/server/tsconfig.test.json',
          './packages/shared/tsconfig.test.json',
          './packages/demo/tsconfig.test.json',
          './apps/web/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Only `access` creates authorized handles (§8.4); execution takes them as given. The
    // core never imports from the optional modules (public API, import, MCP), so a reduced
    // build can leave them out; only the composition root wires them in.
    files: ['apps/server/src/**/*.ts'],
    ignores: [
      'apps/server/src/modules/access/**',
      'apps/server/src/modules/public-api/**',
      'apps/server/src/modules/imports/**',
      'apps/server/src/modules/mcp/**',
      'apps/server/src/app.ts',
      'apps/server/src/services.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: [handlePattern, optionalModulePattern] }],
    },
  },
  {
    files: ['apps/server/src/modules/access/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [optionalModulePattern] }] },
  },
  {
    files: [
      'apps/server/src/modules/public-api/**/*.ts',
      'apps/server/src/modules/imports/**/*.ts',
      'apps/server/src/modules/mcp/**/*.ts',
      'apps/server/src/app.ts',
      'apps/server/src/services.ts',
    ],
    rules: { 'no-restricted-imports': ['error', { patterns: [handlePattern] }] },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: reactHooks.configs.recommended.rules,
  },
)
