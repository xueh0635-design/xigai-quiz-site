#!/usr/bin/env node
"use strict";

const { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } = require("node:fs");
const { resolve, join, dirname } = require("node:path");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { gzipSync } = require("node:zlib");
const root = resolve(__dirname, "..");
const requireMobile = createRequire(join(root, "mobile/package.json"));
const { buildSync } = requireMobile("esbuild");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));

function buildFiles() {
  const files = new Map();
  const catalogVersion = digest(readFileSync(join(root, "content/questions.json")));
  const scripts = json("web/scripts.json");
  let html = readFileSync(join(root, "web/index.template.html"), "utf8");
  for (const entry of scripts) {
    let code;
    if (entry.kind === "bundle") {
      code = buildSync({ absWorkingDir: root, entryPoints: [entry.source], bundle: true,
        minify: true, format: "iife", write: false, logLevel: "silent" }).outputFiles[0].text;
    } else if (entry.kind === "data") {
      const data = json(entry.source);
      code = `window.${entry.global} = ${JSON.stringify(data)};\n`;
      if (entry.id === "questions") code += `window.QuizCatalog = ${JSON.stringify({schemaVersion: 1, version: catalogVersion})};\n`;
    } else code = readFileSync(join(root, entry.source), "utf8");
    const marker = `<!-- quiz:script:${entry.id} -->`;
    if (html.split(marker).length !== 2) throw new Error(`Expected one script marker: ${entry.id}`);
    // Data stays available without fetch, including in the bundled offline application.
    html = html.replace(marker, () => `<script data-quiz-module="${entry.id}">\n${code.replace(/<\/script/gi, "<\\/script")}\n</script>`);
  }
  for (const name of readdirSync(join(root, "web/styles")).sort()) {
    if (!name.endsWith(".css")) continue;
    const css = readFileSync(join(root, "web/styles", name));
    const output = `style-${name.slice(0,-4)}-${digest(css).slice(0,12)}.css`;
    files.set(output, css);
    const marker = `<!-- quiz:style:${name.slice(0,-4)} -->`;
    if (html.split(marker).length !== 2) throw new Error(`Expected one style marker: ${name}`);
    html = html.replace(marker, `<link rel="stylesheet" href="${output}">`);
  }
  if (/<!-- quiz:/.test(html)) throw new Error("Unresolved web template marker");
  for (const name of readdirSync(join(root, "web/assets")).sort()) {
    files.set(`assets/${name}`, readFileSync(join(root, "web/assets", name)));
  }
  const htmlBytes = Buffer.from(html);
  if (gzipSync(htmlBytes).length > 1200000) throw new Error("Core HTML gzip budget exceeded (1.2 MB)");
  if (/data:image\/\w+;base64,[A-Za-z0-9+/=]{100000}/.test(html)) throw new Error("Large inline artwork returned to the core bundle");
  files.set("index.html", htmlBytes);
  const manifest = {schemaVersion: 1, catalogVersion,
    files: Object.fromEntries([...files].sort(([a],[b])=>a.localeCompare(b)).map(([name,bytes])=>[name,digest(bytes)]))};
  files.set("web-manifest.json", Buffer.from(JSON.stringify(manifest,null,2)+"\n"));
  return { files, manifest };
}

function build({ check = false, destination = join(root,"docs") } = {}) {
  const {files,manifest} = buildFiles();
  const mismatches = [];
  for (const [name,bytes] of files) {
    const file = join(destination,name);
    if (check) {
      if (!existsSync(file) || !readFileSync(file).equals(bytes)) mismatches.push(name);
    } else {
      mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,bytes);
    }
  }
  // Only remove generated files whose names identify this build system.
  if (existsSync(destination)) for (const name of readdirSync(destination)) {
    if (/^style-\d+-[a-f0-9]+\.css$/.test(name) && !files.has(name)) {
      if (check) mismatches.push(`stale: ${name}`); else rmSync(join(destination,name));
    }
  }
  const assets = join(destination, "assets");
  if (existsSync(assets)) for (const name of readdirSync(assets)) {
    if (/^art-[a-f0-9]{16}\.[a-z0-9]+$/.test(name) && !files.has(`assets/${name}`)) {
      if (check) mismatches.push(`stale: assets/${name}`); else rmSync(join(assets, name));
    }
  }
  if (mismatches.length) throw new Error(`Generated web bundle is stale: ${mismatches.join(", ")}. Run npm --prefix mobile run build:web.`);
  return {catalogVersion:manifest.catalogVersion,files:files.size,htmlBytes:files.get("index.html").length,htmlGzipBytes:gzipSync(files.get("index.html")).length};
}

if (require.main===module) {
  try { console.log(JSON.stringify(build({check:process.argv.includes("--check")}),null,2)); }
  catch (error) { console.error(error.message); process.exitCode=1; }
}
module.exports={build,buildFiles,digest};
