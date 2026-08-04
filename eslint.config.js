// ESLint 9 flat config. This plugin is plain CommonJS running inside Herdr's
// Node, so the recommended rule set is applied with Node globals and no
// browser/ECMAScript-module assumptions.
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },
  // The TUI tests deliberately match ANSI escape sequences; control characters
  // in those regexes are the point of the test.
  {
    files: ["test/**/*.js"],
    rules: { "no-control-regex": "off" },
  },
];
