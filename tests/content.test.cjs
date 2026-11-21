const test=require("node:test");
const assert=require("node:assert/strict");
const {readFileSync}=require("node:fs");
const {join}=require("node:path");
const {validate}=require("../tools/validate-content.cjs");
const {indexSharedQuestions}=require("../web/scripts/question-catalog.js");
const root=join(__dirname,"..");
const questions=JSON.parse(readFileSync(join(root,"content/questions.json"),"utf8"));
const reasons=JSON.parse(readFileSync(join(root,"content/wrong-option-reasons.json"),"utf8"));
test("the shipped catalog has valid answer and explanation references and one completion denominator",()=>{
  const result=validate(questions,reasons);
  assert.equal(result.rawQuestions,1685);assert.equal(result.canonicalQuestions,1682);
  assert.equal(result.answerableQuestions,1585);assert.equal(result.readingQuestions,97);
});
test("option-letter reordering retains canonical identity without merging contradictory answers",()=>{
  const a={id:"a",chapter:"chapter",type:"单选",stem:" question ",options:{A:"yes",B:"no"},answer:["A"],source:"思政云"};
  const b={...a,id:"b",source:"学习通",options:{A:"no",B:"yes"},answer:["B"]};
  assert.deepEqual(indexSharedQuestions([a,b]).get("b"),["a","b"]);
  assert.equal(indexSharedQuestions([a,{...b,answer:["A"]}]).has("b"),false);
});
test("invalid answer keys and dangling content references block a catalog release",()=>{
  const copy=structuredClone(questions.slice(0,1));
  copy[0].answer=["Z"]; assert.throws(()=>validate(copy),/answer not in options/);
  const q={...questions[0],common_question_id:"missing",related:[]};
  assert.throws(()=>validate([q]),/dangling reference/);
});
