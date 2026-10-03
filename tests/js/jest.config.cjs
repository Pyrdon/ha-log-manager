module.exports = {
  // Repo root so Jest's coverage collector (which filters v8 results by
  // `startsWith(rootDir)`) can see the card module outside tests/js.
  rootDir: "../..",
  testEnvironment: "jsdom",
  testMatch: ["<rootDir>/tests/js/**/*.test.js"],
  transform: {},
  // Babel coverage cannot instrument untransformed ESM; V8 collects from the
  // executed VM scripts, so it measures the imported card module.
  coverageProvider: "v8",
  collectCoverage: true,
  coverageDirectory: "<rootDir>/tests/js/coverage",
  coverageReporters: ["text", "json-summary"],
  roots: ["<rootDir>/tests/js", "<rootDir>/custom_components/log_manager/www"],
  collectCoverageFrom: [
    "<rootDir>/custom_components/log_manager/www/log_manager/log_manager_card.js",
    "<rootDir>/custom_components/log_manager/www/log_manager/card-styles.js",
    "<rootDir>/custom_components/log_manager/www/log_manager/card-styles-base.js",
    "<rootDir>/custom_components/log_manager/www/log_manager/card-styles-dialogs.js",
    "<rootDir>/custom_components/log_manager/www/log_manager/card-styles-recording.js",
    "<rootDir>/custom_components/log_manager/www/log_manager/card-styles-selection.js",
    "<rootDir>/custom_components/log_manager/www/log_manager/card-markup.js",
    "<rootDir>/custom_components/log_manager/www/log_manager/card-utils.js",
    "<rootDir>/custom_components/log_manager/www/log_manager/card-loggers.js",
    "<rootDir>/custom_components/log_manager/www/log_manager/card-add-form.js",
    "<rootDir>/custom_components/log_manager/www/log_manager/card-selection.js",
    "<rootDir>/custom_components/log_manager/www/log_manager/card-recording-setup.js",
    "<rootDir>/custom_components/log_manager/www/log_manager/card-recording-session.js",
    "<rootDir>/custom_components/log_manager/www/log_manager/card-live-view.js",
    "<rootDir>/custom_components/log_manager/www/log_manager/card-results.js",
    "<rootDir>/custom_components/log_manager/www/log_manager/card-context-menu.js",
  ],
  // Gate for the later extraction steps: the monolith measured
  // 85.72% stmts / 75.78% branch / 79.9% funcs / 85.72% lines before the split.
  // Thresholds sit below that with headroom so extractions must not regress.
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 70,
      functions: 75,
      lines: 80,
    },
  },
};
