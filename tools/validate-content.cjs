#!/usr/bin/env node
"use strict";
const {readFileSync}=require("node:fs");
const {join}=require("node:path");
const catalog=require("../web/scripts/question-catalog.js");
const root=join(__dirname,"..");
function validate(questions,reasons={}) {
  if(!Array.isArray(questions) || !questions.length) throw new Error("Question catalog must be a non-empty array");
  const byId=new Map();
  for(const q of questions) {
    if(!q || typeof q.id!=="string" || !q.id || ["__proto__","constructor","prototype"].includes(q.id) || byId.has(q.id)) throw new Error(`Invalid or duplicate question ID: ${q?.id}`);
    for(const field of ["chapter","type","stem","review_status"]) if(typeof q[field]!=="string" || !q[field].trim()) throw new Error(`${q.id}: missing ${field}`);
    if(!q.options || Array.isArray(q.options) || typeof q.options!=="object" || !Array.isArray(q.answer)) throw new Error(`${q.id}: invalid options/answer`);
    if(q.review_status==="可练习") {
      if(!q.answer.length || new Set(q.answer).size!==q.answer.length) throw new Error(`${q.id}: missing/duplicate answer`);
      if(q.type!=="填空" && q.answer.some(letter=>!Object.hasOwn(q.options,letter))) throw new Error(`${q.id}: answer not in options`);
      if(["单选","判断"].includes(q.type) && q.answer.length!==1) throw new Error(`${q.id}: expected one answer`);
    }
    byId.set(q.id,q);
  }
  for(const q of questions) for(const id of [q.common_question_id,...(q.related || [])].filter(Boolean)) {
    if(!byId.has(id)) throw new Error(`${q.id}: dangling reference ${id}`);
  }
  for(const [id,entries] of Object.entries(reasons)) {
    const q=byId.get(id);if(!q)throw new Error(`Reasons refer to missing question: ${id}`);
    for(const [letter,note] of Object.entries(entries)) {
      if(q.options[letter]!==note.option || q.answer.includes(letter) || !note.reason?.trim()) throw new Error(`${id}/${letter}: reason does not match a distractor`);
    }
  }
  const rows=catalog.canonicalRows(questions);
  const canonical=new Map(rows.map(row=>[row.canonicalId,row]));
  return {rawQuestions:questions.length,canonicalQuestions:canonical.size,
    answerableQuestions:[...canonical.values()].filter(row=>row.answerable).length,
    readingQuestions:[...canonical.values()].filter(row=>!row.answerable).length,
    reasonGroups:Object.keys(reasons).length};
}
if(require.main===module){try{
  const read=name=>JSON.parse(readFileSync(join(root,"content",name),"utf8"));
  console.log(JSON.stringify(validate(read("questions.json"),read("wrong-option-reasons.json")),null,2));
}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={validate};
