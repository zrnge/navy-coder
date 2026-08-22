// ESLint flat config.
//
// ESLint was in devDependencies with no configuration at all, so `npx eslint`
// only ever printed a migration notice — the lint safety net has never actually
// run on this repo. This is a deliberately narrow rule set: everything here
// catches a real defect (a typo'd name, an unreachable branch, a duplicated
// object key), and nothing here is style. `npm run check` already parses every
// file; formatting is Prettier's job. A linter that shouts about spacing is a
// linter people stop reading.
//
// No plugins and no shared config package: `@eslint/js` and `globals` are not
// installed, and adding dependencies to lint a zero-dependency extension would
// be its own kind of wrong. Globals are listed explicitly below.

const NODE_GLOBALS = {
  require: 'readonly', module: 'writable', exports: 'writable',
  process: 'readonly', console: 'readonly', Buffer: 'readonly',
  __dirname: 'readonly', __filename: 'readonly', global: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', queueMicrotask: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', TextDecoder: 'readonly',
  TextEncoder: 'readonly', AbortController: 'readonly', fetch: 'readonly',
  structuredClone: 'readonly', performance: 'readonly',
};

// media/main.js runs inside the VS Code webview: a browser, plus the one API
// the host injects.
const WEBVIEW_GLOBALS = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  console: 'readonly', location: 'readonly', fetch: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  MutationObserver: 'readonly', ResizeObserver: 'readonly', IntersectionObserver: 'readonly',
  Event: 'readonly', CustomEvent: 'readonly', MouseEvent: 'readonly',
  KeyboardEvent: 'readonly', MessageEvent: 'readonly', DOMParser: 'readonly',
  Element: 'readonly', HTMLElement: 'readonly', Node: 'readonly', NodeList: 'readonly',
  Blob: 'readonly', File: 'readonly', FileReader: 'readonly', URL: 'readonly',
  Image: 'readonly', getComputedStyle: 'readonly', matchMedia: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly', atob: 'readonly', btoa: 'readonly',
  SpeechSynthesisUtterance: 'readonly', speechSynthesis: 'readonly',
  SpeechRecognition: 'readonly', webkitSpeechRecognition: 'readonly',
  AbortController: 'readonly', structuredClone: 'readonly', performance: 'readonly',
  CSS: 'readonly', queueMicrotask: 'readonly',
  acquireVsCodeApi: 'readonly',
};

const CORRECTNESS_RULES = {
  // A name that does not exist — the typo class, and the reason to have a
  // linter at all in a language that fails at runtime instead of at build.
  'no-undef': 'error',
  'no-unused-vars': ['warn', {
    args: 'none',                 // handlers routinely ignore their arguments
    varsIgnorePattern: '^_',
    caughtErrors: 'none',         // `catch (e) {}` with an unused e is idiomatic here
  }],
  // Silent logic defects.
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-sparse-arrays': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-obj-calls': 'error',
  'no-invalid-regexp': 'error',
  'no-control-regex': 'off',      // control characters in regexes are deliberate here
  'no-misleading-character-class': 'error',
  'no-async-promise-executor': 'error',
  'require-atomic-updates': 'off', // too many false positives on this codebase's turn loop
  'no-empty': ['error', { allowEmptyCatch: true }],
};

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', '.vscode-test/**', 'eval/results/**', 'media/icon*.svg'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    rules: CORRECTNESS_RULES,
  },
  {
    // The webview script is not a module and never sees `require`.
    files: ['media/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: WEBVIEW_GLOBALS,
    },
    rules: CORRECTNESS_RULES,
  },
];
