import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      parserOptions: {
          project: ['./tsconfig.main.json', './tsconfig.renderer.json', './tsconfig.preload.json'],
      },
    },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  prettier,
  { ignores: ['dist/', 'src/dist/', 'src/i18n/', 'src/renderer/i18n/i18n-*.ts', 'src/renderer/i18n/i18n-*.tsx', 'node_modules/', '.old/', 'release/', 'src/main/modules/userscripts/bundled-scripts/css-fixer.user.js', 'src/main/modules/userscripts/bundled-scripts/vendor/'] },
];
