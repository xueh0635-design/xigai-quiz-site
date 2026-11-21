const test = require("node:test");
const assert = require("node:assert/strict");
const {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync} = require("node:fs");
const {tmpdir} = require("node:os");
const {join} = require("node:path");
const {createHash} = require("node:crypto");
const {copyWeb, safePath} = require("../tools/copy-web.cjs");
const {build} = require("../tools/build-web.cjs");
const hash = text => createHash("sha256").update(text).digest("hex");
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "quiz-assets-"));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  const source = join(directory, "docs"), destination = join(directory, "mobile/www");
  mkdirSync(join(source,"assets"), {recursive:true}); mkdirSync(destination, {recursive:true});
  writeFileSync(join(source,"index.html"), '<img src="assets/card.webp">');
  writeFileSync(join(source,"assets/card.webp"), "test image bytes");
  const files = {"index.html":hash('<img src="assets/card.webp">'), "assets/card.webp":hash("test image bytes")};
  const manifest = {schemaVersion:1,catalogVersion:"test",files};
  writeFileSync(join(source,"web-manifest.json"),JSON.stringify(manifest));
  return {source,destination,manifest};
}
test("native copy includes every manifested resource and removes stale destination files", t => {
  const {source,destination}=fixture(t);
  writeFileSync(join(destination,"stale.js"),"old");
  assert.equal(copyWeb(destination,source).files,3);
  assert.equal(readFileSync(join(destination,"assets/card.webp"),"utf8"),"test image bytes");
  assert.equal(existsSync(join(destination,"stale.js")),false);
});
test("tampered or missing assets fail before replacing the previous working native bundle", t => {
  const {source,destination}=fixture(t);
  writeFileSync(join(destination,"keep.txt"),"working build");
  writeFileSync(join(source,"assets/card.webp"),"changed");
  assert.throws(()=>copyWeb(destination,source),/digest mismatch/);
  assert.equal(readFileSync(join(destination,"keep.txt"),"utf8"),"working build");
  rmSync(join(source,"assets/card.webp"));
  assert.throws(()=>copyWeb(destination,source),/ENOENT/);
  assert.equal(existsSync(join(destination,"keep.txt")),true);
});
test("copy rejects path traversal and arbitrary deletion targets",t=>{
  const {source,destination,manifest}=fixture(t);
  for(const name of ["../secret","/tmp/file","assets/../../secret","assets\\secret","a//b","a/./b"]) {
    assert.throws(()=>safePath(name),/Unsafe/);
  }
  manifest.files["../outside.txt"]=hash("x");
  writeFileSync(join(source,"web-manifest.json"),JSON.stringify(manifest));
  assert.throws(()=>copyWeb(destination,source),/Unsafe/);
  assert.throws(()=>copyWeb(join(destination,".."),source),/Destination must/);
});
test("bundle checks reject retired generated assets and rebuilding removes them", t => {
  const directory = mkdtempSync(join(tmpdir(), "quiz-build-"));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  build({destination:directory});
  const stale = join(directory,"assets/art-0000000000000000.webp");
  writeFileSync(stale,"retired art");
  assert.throws(()=>build({check:true,destination:directory}),/stale: assets/);
  build({destination:directory});
  assert.equal(existsSync(stale),false);
});
test("copy refuses a source contained in its destination and a linked deletion target",t=>{
  const {source,destination}=fixture(t);
  writeFileSync(join(destination,"keep.txt"),"working build");
  assert.throws(()=>copyWeb(destination,join(destination,"source")),/Source must not/);
  assert.equal(existsSync(join(destination,"keep.txt")),true);
  rmSync(destination,{recursive:true});
  symlinkSync(source,destination,"dir");
  assert.throws(()=>copyWeb(destination,source),/symbolic links/);
  assert.equal(existsSync(join(source,"index.html")),true);
});
