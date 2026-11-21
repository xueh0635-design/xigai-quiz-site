const { cpSync, existsSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const target = join(__dirname, "..", "android", "app");
if (!existsSync(join(target, "build.gradle"))) {
  throw new Error("Run npx cap add android in mobile before installing the Android sources.");
}
// Replacing this package also removes native classes deleted from the source overlay.
rmSync(join(target, "src/main/java/io/github/xueh0635/xigai"), { recursive: true, force: true });
cpSync(join(__dirname, "app"), target, { recursive: true });
