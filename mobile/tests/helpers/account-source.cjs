const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

// Execute the real modules with a supplied Supabase client. The production
// bundle uses esbuild; these tests need no build tool or network connection.
exports.accountSource = () => ["study-state.mjs", "quiz-store.mjs", "account.js"].map((name) =>
  readFileSync(resolve(__dirname, "../..", name), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace(/^export /gm, ""),
).join("\n");
