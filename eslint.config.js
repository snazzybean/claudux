// The recommended set plus scope and unused-binding errors, because
// `public/` has no test suite and `node --check` sees syntax, not
// identifier visibility.
//
// No style or formatting rules: comments are wrapped by hand and a
// formatter would reflow them.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The probes under scripts/probe/. Their own entry because the globs
    // above end in `*.js` and every one of these is an `.mjs`, so until this
    // block existed `eslint .` skipped them entirely - and lint plus these
    // probes are the whole safeguard for public/.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // Both global sets, and that is the point of the entry: a probe is a
      // node script, but its `page.evaluate` bodies are written in the same
      // file and run in the page. The cost is that `document` in a part that
      // never reaches the browser goes unnoticed here.
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // public/ runs in the browser. app.js and the modules under public/js/
    // are loaded via <script type="module"> and import each other.
    files: ['public/app.js', 'public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The service worker is deliberately NOT a module: it's loaded by
    // navigator.serviceWorker.register() without { type: 'module' } and
    // runs in its own scope with its own globals.
    files: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: globals.serviceworker,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
