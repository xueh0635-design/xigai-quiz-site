#!/usr/bin/env node
"use strict";
const {readFileSync,mkdirSync,copyFileSync,rmSync,existsSync,lstatSync} = require("node:fs");
const {resolve,join,dirname,isAbsolute,sep} = require("node:path");
const {createHash} = require("node:crypto");
const root=resolve(__dirname,"..");
function safePath(name) {
  if(typeof name!=="string" || name.includes("\\") || name.includes("\0") || isAbsolute(name) || name.split("/").some(x=>!x || x==="." || x==="..")) throw new Error("Unsafe web manifest path");
  return name;
}
function copyWeb(destination=join(root,"mobile/www"),source=join(root,"docs")) {
  destination=resolve(destination); source=resolve(source);
  // This CLI only owns a Capacitor webDir named www. Never recursively remove an arbitrary caller path.
  if(!destination.endsWith("/mobile/www") || destination===source) throw new Error("Destination must be a repository's mobile/www directory");
  if(source.startsWith(destination+sep)) throw new Error("Source must not be inside the directory being replaced");
  for(let current=destination;dirname(current)!==current;current=dirname(current)) {
    if(existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Destination must not contain symbolic links");
  }
  const manifest=JSON.parse(readFileSync(join(source,"web-manifest.json"),"utf8"));
  if(manifest.schemaVersion!==1 || !manifest.files || !manifest.files["index.html"]) throw new Error("Unsupported web manifest");
  for(const [name,expected] of Object.entries(manifest.files)) {
    safePath(name);
    const bytes=readFileSync(join(source,name));
    if(createHash("sha256").update(bytes).digest("hex")!==expected) throw new Error(`Web resource digest mismatch: ${name}`);
  }
  if(existsSync(destination)) rmSync(destination,{recursive:true});
  mkdirSync(destination,{recursive:true});
  for(const name of [...Object.keys(manifest.files),"web-manifest.json"]) {
    const target=join(destination,safePath(name));mkdirSync(dirname(target),{recursive:true});copyFileSync(join(source,name),target);
  }
  return {destination,files:Object.keys(manifest.files).length+1};
}
if(require.main===module){try{console.log(JSON.stringify(copyWeb(process.argv[2]),null,2));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={copyWeb,safePath};
