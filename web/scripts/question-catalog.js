/* One canonical question identity rule for the application and content validation. */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QuizQuestionCatalog = api;
})(typeof window === "object" ? window : globalThis, () => {
  "use strict";
  const labels = { all: "全部题库", sizheng: "思政云", xuexitong: "学习通", common: "常考题" };
  const questionTextKey = (value) => value.normalize("NFC").trim().replace(/\s+/gu, " ");
  function inBank(item, bank) {
    return bank === "all" || (item.source || labels.sizheng) === labels[bank] || item.also_in === labels[bank];
  }
  function indexSharedQuestions(pool) {
    const matches = new Map(), shared = new Map();
    for (const item of pool) {
      if (inBank(item,"sizheng") && inBank(item,"xuexitong")) shared.set(item.id,[item.id]);
      const options = Object.values(item.options).map(questionTextKey);
      if (new Set(options).size !== options.length) continue;
      const answers = options.length
        ? item.answer.map(letter => item.options[letter] ? questionTextKey(item.options[letter]) : undefined).sort()
        : (item.blank_answers || item.answer.map(value=>value.split(/[;；]/)))
          .map(field=>[...new Set(field.map(questionTextKey))].sort());
      if (answers.includes(undefined) || !answers.length) continue;
      const key=JSON.stringify([item.chapter,item.type,questionTextKey(item.stem),options.sort(),answers]);
      if (!matches.has(key)) matches.set(key,[]);
      matches.get(key).push(item);
    }
    for (const items of matches.values()) {
      if(items.length<2 || !items.some(item=>inBank(item,"sizheng")) || !items.some(item=>inBank(item,"xuexitong"))) continue;
      const anchor=items.find(item=>item.common_question_id===item.id) ||
        items.find(item=>(item.source || labels.sizheng)===labels.sizheng) || items[0];
      const ids=[anchor.id,...items.filter(item=>item!==anchor).map(item=>item.id)];
      for(const id of ids) shared.set(id,ids);
    }
    return shared;
  }
  function canonicalRows(pool) {
    const shared=indexSharedQuestions(pool);
    return pool.map(item=>({id:item.id,canonicalId:shared.get(item.id)?.[0] || item.id,
      chapter:item.chapter,type:item.type,answerable:item.type!=="填空" && item.review_status==="可练习"}));
  }
  return {questionTextKey,inBank,indexSharedQuestions,canonicalRows};
});
