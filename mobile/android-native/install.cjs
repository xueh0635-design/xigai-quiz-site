const { cpSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const target = join(__dirname, "..", "android", "app");
if (!existsSync(join(target, "build.gradle"))) {
  throw new Error("Run npx cap add android in mobile before installing the Android sources.");
}
cpSync(join(__dirname, "app"), target, { recursive: true });
