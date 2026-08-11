/*
 * Jest configuration.
 *
 * Lives here rather than in package.json so the reasons can sit next to the
 * settings — package.json rejects unknown keys, so a comment field there is a
 * validation warning on every run.
 */
module.exports = {
  // Runs before any test module is required, because the thing it isolates —
  // where API keys are read from — is resolved at require time. See the file
  // for the deploy-only failure that made it necessary.
  setupFiles: ['<rootDir>/tests/setup.env.js'],

  moduleNameMapper: {
    '^uuid$': '<rootDir>/tests/__mocks__/uuid.js',
  },

  testPathIgnorePatterns: [
    '/node_modules/',

    // quant-platform is a separate tool sharing this repository. Its tests are
    // Python and are run by its own tooling.
    '/quant-platform/',

    // trading.integration.test.js exercises src/trading/* and src/journal/*,
    // which are not in this repository and never have been on any branch — the
    // file arrived in an unrelated commit. Requiring them at load time failed
    // the whole suite on every run, which is the surest way to stop anyone
    // noticing a real failure. Ignored rather than deleted, so it is still
    // here if that tool is ever built; delete this line then.
    '<rootDir>/tests/trading.integration.test.js',
  ],
};
