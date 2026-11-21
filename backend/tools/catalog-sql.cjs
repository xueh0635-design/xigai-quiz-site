const fs = require('node:fs');
const crypto = require('node:crypto');
const { canonicalRows } = require('../../web/scripts/question-catalog.js');

function catalogRows(questions) {
  const canonical = new Map(canonicalRows(questions).map(row => [row.id, row]));
  return questions.map(q => ({
    id: q.id,
    canonical: canonical.get(q.id).canonicalId,
    chapter: q.chapter,
    type: q.type,
    answerable: canonical.get(q.id).answerable,
    options: Object.keys(q.options).sort(),
    answer: q.type === '填空' ? [] : [...q.answer].sort(),
  }));
}

function renderCatalog(bytes) {
  const version = crypto.createHash('sha256').update(bytes).digest('hex');
  const rows = catalogRows(JSON.parse(bytes));
  const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
  const array = values => values.length ? 'array[' + values.map(literal).join(',') + ']' : "'{}'::text[]";
  const values = rows.map(q => `  (${literal(q.id)}, ${literal(q.canonical)}, ${literal(q.chapter)}, ${literal(q.type)}, ${q.answerable}, ${array(q.options)}, ${array(q.answer)}, ${literal(version)})`);
  return `-- Generated from content/questions.json; SHA-256 ${version}.\n` +
    `-- Existing online-game options remain unchanged; practice grading has its own complete catalog.\n` +
    `insert into quiz_pk_private.questions as current (question_id,canonical_question_id,chapter,question_type,answerable,practice_options,practice_correct_options,catalog_version)\n` +
    `values\n${values.join(',\n')}\non conflict(question_id) do update set\n` +
    `  canonical_question_id=excluded.canonical_question_id,chapter=excluded.chapter,question_type=excluded.question_type,\n` +
    `  live_enabled=current.live_enabled and (current.catalog_version is null or (current.practice_options=excluded.practice_options and current.practice_correct_options=excluded.practice_correct_options)),\n` +
    `  arena_enabled=current.arena_enabled and (current.catalog_version is null or (current.practice_options=excluded.practice_options and current.practice_correct_options=excluded.practice_correct_options)),\n` +
    `  answerable=excluded.answerable,practice_options=excluded.practice_options,practice_correct_options=excluded.practice_correct_options,\n` +
    `  catalog_version=excluded.catalog_version;\n` +
    `-- Retire removed questions without deleting versions referenced by attempts or games.\n` +
    `update quiz_pk_private.questions set answerable=false,live_enabled=false,arena_enabled=false\n` +
    `where catalog_version is distinct from ${literal(version)};\n` +
    `insert into quiz_sync_private.question_versions\n` +
    `  select catalog_version,question_id,canonical_question_id,chapter,question_type,answerable,practice_options,practice_correct_options\n` +
    `  from quiz_pk_private.questions where catalog_version=${literal(version)}\n` +
    `  on conflict(catalog_version,question_id) do nothing;\n`;
}

module.exports = { catalogRows, renderCatalog };
if (require.main === module) {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: node backend/tools/catalog-sql.cjs content/questions.json');
  process.stdout.write(renderCatalog(fs.readFileSync(input)));
}
