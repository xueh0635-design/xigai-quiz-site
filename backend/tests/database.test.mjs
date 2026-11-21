import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { createQuizStore } from '../../mobile/quiz-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'mobile/package.json'));
const { PGlite } = require('@electric-sql/pglite');
const { IDBFactory } = require('fake-indexeddb');
const { canonicalRows } = require('../web/scripts/question-catalog.js');
const { renderCatalog } = require('../backend/tools/catalog-sql.cjs');
const content = await fs.readFile(path.join(root,'content/questions.json'));
const version = createHash('sha256').update(content).digest('hex');

export async function database(onlyMigrations) {
  const db = new PGlite();
  await db.exec(`
    create publication supabase_realtime;
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, raw_app_meta_data jsonb not null default '{}', email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid
    $$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets,
      name text,updated_at timestamptz default now());
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated,service_role;
    grant select,insert,update,delete on storage.objects to authenticated;
  `);
  const directory = path.join(root, 'backend/supabase/migrations');
  for (const name of (await fs.readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    if (onlyMigrations && !onlyMigrations.includes(name)) continue;
    try { await db.exec(await fs.readFile(path.join(directory,name),'utf8')); }
    catch (error) { await db.close(); throw new Error(`Migration ${name}: ${error.message}`); }
  }
  return db;
}

test('the deployed legacy API accepts review drafts and enforces account ownership', async t => {
  const db = await database([
    '20261117194920_quiz_accounts_and_progress.sql',
    '20261117195650_quiz_bind_outbox_to_account.sql',
    '20261120195728_quiz_question_notes.sql',
    '20261121191857_sync_wrong_review_drafts.sql',
  ]);
  t.after(() => db.close());
  const own = randomUUID();
  const other = randomUUID();
  await db.query('insert into auth.users(id) values ($1), ($2)', [own, other]);
  await db.query('insert into public.quiz_members(account_id) values ($1), ($2)', [own, other]);
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [own]);
  const sid = 'wrong-book:all:第一章';
  const archive = { sid, ids: ['q2'], wrongBookReview: true, index: 1, wrongBookRound: 2,
    wrongBookOriginalIds: ['q1', 'q2'], wrongBookRoundCounts: [1, 0] };
  const draft = { ...archive, sid: sid + ':next', index: 0, wrongBookRound: 1, selected: ['B'], wrongBookRoundCounts: [] };
  const row = (payload, revision) => ({ kind: 'draft', record_key: payload.sid, payload, change_id: randomUUID(), revision });
  const merge = (account, ...rows) => db.query('select public.merge_account_quiz_state($1::uuid,$2::jsonb)', [account, JSON.stringify(rows)]);
  await merge(own, row(archive, 100), row(draft, 100));
  await merge(own, row({ ...archive, wrongBookRoundCounts: [] }, 99));
  assert.deepEqual((await db.query("select payload from public.quiz_state where kind='draft' order by record_key")).rows,
    [{ payload: archive }, { payload: draft }]);
  await assert.rejects(merge(own, row({ ...draft, wrongBookReview: undefined }, 101)), /check constraint/);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [other]);
  assert.deepEqual((await db.query("select record_key from public.quiz_state where kind='draft'")).rows, []);
  await assert.rejects(merge(own, row(draft, 101)), /account not enrolled/);
});

test('cold migrations, authorization, incremental sync and append-only attempts', async t => {
  const db = await database();
  t.after(() => db.close());
  const one = '10000000-0000-4000-8000-000000000001';
  const two = '10000000-0000-4000-8000-000000000002';
  const outsider = '10000000-0000-4000-8000-000000000003';
  const scalar = async (sql,args=[]) => (await db.query(sql,args)).rows[0];
  const now = Number((await scalar('select floor(extract(epoch from statement_timestamp())*1000) as now')).now);
  const actor = async (id,role='authenticated') => {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id || '']);
    await db.exec('set role '+role);
  };
  const rpc = async (input={}) => (await scalar('select public.quiz_sync_v2($1::uuid,$2::jsonb,$3::jsonb,$4::bigint,$5::integer) as result',
    [input.account || one,JSON.stringify(input.changes || []),JSON.stringify(input.attempts || []),input.cursor ?? 0,input.page_size ?? 200])).result;
  const change = (kind,key,payload,n=1) => ({kind,record_key:key,payload,revision:now+n,
    change_id:`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`});
  const attempt = (n,question='新增（必刷）-1',selected=['B'],time=now) => ({
    event_id:`30000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
    question_id:question,selected,occurred_at:time,mode:'practice',catalog_version:version,
  });
  await db.query("insert into auth.users(id,raw_app_meta_data) values ($1,'{\"quiz_enrollment\":\"direct-email-v1\"}'),($2,'{\"quiz_enrollment\":\"direct-email-v1\"}'),($3,'{}')",[one,two,outsider]);

  await t.test('complete practice catalog preserves online-game eligibility', async () => {
    const counts = await scalar(`select count(*)::int as raw,
      count(distinct canonical_question_id) filter(where answerable)::int as answerable,
      count(*) filter(where live_enabled)::int as live,
      count(*) filter(where arena_enabled)::int as arena from quiz_pk_private.questions`);
    assert.deepEqual(counts,{raw:1685,answerable:1585,live:1157,arena:1157});
  });
  await t.test('deployed catalog seed matches shared content version and canonical identities', async () => {
    const directory=path.join(root,'backend/supabase/migrations');
    const files=(await fs.readdir(directory)).filter(name=>name.endsWith('.sql')).sort();
    const source=await Promise.all(files.map(name=>fs.readFile(path.join(directory,name),'utf8')));
    assert.ok(source.some(sql=>sql.includes(renderCatalog(content))),
      'Content changed: generate a new catalog migration before publishing the client.');
    const rows=(await db.query(`select question_id as id,canonical_question_id as "canonicalId",chapter,
      question_type as type,answerable from quiz_pk_private.questions where catalog_version=$1`,[version])).rows;
    const byId=(a,b)=>a.id.localeCompare(b.id);
    assert.deepEqual(rows.sort(byId),canonicalRows(JSON.parse(content)).sort(byId));
    assert.equal((await scalar('select count(distinct catalog_version)::int as count from quiz_pk_private.questions')).count,1);
    const provenance=JSON.parse(await fs.readFile(path.join(root,'backend/supabase/recovered-sources.json')));
    for(const migration of provenance.migrations) {
      const bytes=await fs.readFile(path.join(directory,`${migration.version}_${migration.name}.sql`));
      assert.equal(createHash('sha256').update(bytes).digest('hex'),migration.repository_sha256);
    }
  });
  await t.test('anonymous, non-member and mismatched-account requests fail', async () => {
    await actor(null,'anon');
    await assert.rejects(rpc(),/permission denied/);
    await actor(outsider);
    await assert.rejects(rpc({account:outsider}),/account not enrolled/);
    await actor(one);
    await assert.rejects(rpc({account:two}),/account not enrolled/);
    await assert.rejects(db.query('select * from quiz_sync_private.attempts'),/permission denied/);
  });
  let first;
  await t.test('v2 saves states, drafts, test summaries and server-graded events atomically', async () => {
    const a = attempt(1);
    first = await rpc({attempts:[a],changes:[
      change('history',a.question_id,{wrong:false,last:now,selected:['B']},1),
      change('draft','40000000-0000-4000-8000-000000000001',{sid:'draft',ids:[a.question_id],index:0},2),
      change('test','40000000-0000-4000-8000-000000000002',{bank:'all',chapter:'第一章',correct:1,total:1,completedAt:now},3),
    ]});
    assert.equal(first.version,2);
    assert.equal(first.ack.changes.length,3);
    assert.deepEqual(first.ack.attempts,[a.event_id]);
    assert.equal(first.attemptRows.length,1);
    assert.equal(first.attemptRows[0].source,'v2');
    assert.equal(first.attemptRows[0].correct,true);
    assert.equal(first.rows.length,3);
    assert.equal(first.has_more,false);
  });
  await t.test('retries are idempotent and conflicts reject the entire batch', async () => {
    const retry = await rpc({attempts:[attempt(1)],cursor:first.next_cursor});
    assert.equal(retry.attemptRows.length,0);
    await assert.rejects(rpc({attempts:[attempt(1,'新增（必刷）-1',['A'])],
      changes:[change('note','never-committed','no',4)]}),/quiz_attempt_conflict/);
    assert.equal((await db.query("select * from public.quiz_state where record_key='never-committed'")).rows.length,0);
  });
  await t.test('pagination uses a shared cursor and a no-change pull is empty', async () => {
    let cursor=0, more=true; const seen=[];
    for(let safety=0;more && safety<20;safety++) {
      const page=await rpc({cursor,page_size:1});
      seen.push(...page.rows,...page.attemptRows);
      assert.ok(page.next_cursor>cursor || !page.has_more);
      cursor=page.next_cursor;more=page.has_more;
    }
    assert.equal(more,false);
    assert.equal(seen.length,4);
    assert.equal(new Set(seen.map(row=>row.sync_cursor)).size,4);
    const empty=await rpc({cursor});
    assert.deepEqual(empty.rows,[]);assert.deepEqual(empty.attemptRows,[]);
  });
  await t.test('legacy merge writes participate in the same cursor and preserve history', async () => {
    const cursor=(await rpc()).next_cursor;
    await db.query('select public.merge_account_quiz_state($1::uuid,$2::jsonb)',[one,JSON.stringify([
      change('history','新增（必刷）-2',{wrong:false,last:now,selected:['C']},5),
    ])]);
    const page=await rpc({cursor});
    assert.equal(page.rows.length,1);assert.equal(page.attemptRows.length,1);
    assert.equal(page.attemptRows[0].source,'legacy_sync');
    await actor(two);
    assert.equal((await db.query('select * from public.quiz_state')).rows.length,0);
    await assert.rejects(db.query(`insert into public.quiz_state(account_id,kind,record_key,revision,change_id,payload)
      values($1,'star','other',1,gen_random_uuid(),'true')`,[one]),/row-level security/);
    await actor(one);
  });
  await t.test('upgraded legacy pending histories retain activity before deferred v2 evidence arrives', async t => {
    const learner='10000000-0000-4000-8000-000000000007';
    await db.exec('reset role');
    await db.query("insert into auth.users(id,raw_app_meta_data) values($1,'{\"quiz_enrollment\":\"direct-email-v1\"}')",[learner]);
    await actor(learner);
    const snapshots=[
      change('history','新增（必刷）-1',{wrong:false,last:now,selected:['A']},401),
      change('history','新增（必刷）-2',{wrong:false,last:now,selected:['C']},402),
    ];
    const records=Object.fromEntries(snapshots.map(row=>[row.kind+':'+row.record_key,row]));
    const store=await createQuizStore({scope:'account:'+learner,legacyKey:'legacy-upgrade',
      indexedDB:new IDBFactory(),randomId:randomUUID,
      legacyStorage:{getItem:()=>JSON.stringify({records,pending:records})}});
    t.after(()=>store.close());
    const imported=await store.read();
    assert.equal(Object.keys(imported.pending).length,2);
    assert.deepEqual(await store.pendingAttempts(),[]);
    const saved=await rpc({account:learner,changes:Object.values(imported.pending)});
    assert.equal(saved.attemptRows.length,2);
    assert.ok(saved.attemptRows.every(row=>row.source==='legacy_sync'));
    await store.accept({rows:saved.rows,attempts:saved.attemptRows,ackChanges:saved.ack.changes,
      ackAttempts:saved.ack.attempts,cursor:saved.next_cursor});
    assert.deepEqual((await store.read()).pending,{});
    let dashboard=(await scalar('select public.quiz_pk_dashboard() as result')).result;
    assert.equal(dashboard.me.today,2);
    assert.equal(dashboard.me.answered,2);
    assert.equal(dashboard.me.correct,2);
    assert.equal((await scalar('select public.quiz_leaderboard_today() as result')).result.me.answered,2);

    const duplicate=await rpc({account:learner,changes:snapshots,cursor:saved.next_cursor});
    assert.deepEqual(duplicate.attemptRows,[]);
    const evidence=attempt(401,'新增（必刷）-1',['A']);
    const verified=await rpc({account:learner,attempts:[evidence],cursor:duplicate.next_cursor});
    assert.equal(verified.attemptRows.length,1);
    assert.equal(verified.attemptRows[0].source,'v2');
    assert.equal(verified.attemptRows[0].correct,false);
    dashboard=(await scalar('select public.quiz_pk_dashboard() as result')).result;
    assert.equal(dashboard.me.today,2);
    assert.equal(dashboard.me.correct,1);
    await db.exec('reset role');
    const activity=(await scalar('select quiz_pk_private.progress_rollups($1,$2) as result',[learner,two])).result;
    assert.equal(activity.days[0].mine,2);
    assert.equal(activity.days[0].mineCorrect,1);
    assert.equal((await scalar('select count(*)::int as count from quiz_sync_private.attempts where account_id=$1',[learner])).count,3);
    await actor(learner);
    assert.deepEqual((await rpc({account:learner,attempts:[evidence],cursor:verified.next_cursor})).attemptRows,[]);
    await actor(one);
  });
  await t.test('rolled-back writes do not leave an uncommitted low cursor to skip', async () => {
    const before=(await rpc()).next_cursor;
    await db.exec('begin');
    await rpc({attempts:[attempt(90)]});
    await db.exec('rollback');
    const after=await rpc({cursor:before});
    assert.equal(after.next_cursor,before);
    const saved=await rpc({attempts:[attempt(91)],cursor:before});
    assert.equal(saved.attemptRows.length,1);
    assert.ok(saved.next_cursor>before);
  });
  await t.test('invalid questions, options, cursors and private table mutations are rejected', async () => {
    await assert.rejects(rpc({attempts:[attempt(100,'missing',['A'])]}),/quiz_catalog_unavailable/);
    await assert.rejects(rpc({attempts:[attempt(101,'新增（必刷）-1',['Z'])]}),/quiz_invalid_attempt/);
    await assert.rejects(rpc({attempts:[attempt(102,'新增（必刷）-1',['B','B'])]}),/quiz_invalid_attempt/);
    await assert.rejects(rpc({attempts:[{...attempt(103),catalog_version:'unpublished'}],
      changes:[change('note','unpublished-rollback','never committed',103)]}),/quiz_catalog_unavailable/);
    assert.equal((await db.query("select * from public.quiz_state where record_key='unpublished-rollback'")).rows.length,0);
    await assert.rejects(rpc({cursor:9007199254740990}),/quiz_cursor_ahead/);
    await assert.rejects(db.query('delete from quiz_sync_private.attempts'),/permission denied/);
  });
  await t.test('closing a draft with JSON null commits together with its final attempt and test', async () => {
    const result=await rpc({attempts:[{...attempt(110),mode:'chapter-test'}],changes:[
      change('draft','40000000-0000-4000-8000-000000000001',null,110),
      change('test','completed-draft',{bank:'all',chapter:'新增（必刷）',correct:1,total:1,completedAt:now},111),
    ]});
    assert.equal(result.ack.changes.length,2);
    assert.equal(result.ack.attempts.length,1);
    assert.equal(result.rows.find(row=>row.kind==='draft').payload,null);
  });
  await t.test('physical deletion is delivered once and stale writes cannot resurrect it', async () => {
    const cursor=(await rpc()).next_cursor;
    await db.exec('reset role');
    await db.query("delete from public.quiz_state where account_id=$1 and kind='draft'",[one]);
    await actor(one);
    const page=await rpc({cursor});
    assert.equal(page.rows.length,1);
    assert.equal(page.rows[0].deleted,true);
    const tombstone=page.rows[0];
    await db.query('select public.merge_account_quiz_state($1::uuid,$2::jsonb)',[one,JSON.stringify([
      change('draft',tombstone.record_key,{sid:'stale'},2),
    ])]);
    assert.equal((await db.query("select * from public.quiz_state where kind='draft'")).rows.length,0);
  });
  await t.test('today practice leaves yesterday activity unchanged and test records survive session replacement', async () => {
    const learner='10000000-0000-4000-8000-000000000004';
    await db.exec('reset role');
    await db.query("insert into auth.users(id,raw_app_meta_data) values($1,'{\"quiz_enrollment\":\"direct-email-v1\"}')",[learner]);
    await actor(learner);
    const old=now-86400000;
    const events=[attempt(201,'新增（必刷）-1',['B'],old),attempt(202,'新增（必刷）-2',['C'],old)];
    await rpc({account:learner,attempts:events,changes:[
      change('test','test-a',{bank:'all',chapter:'第一章',correct:10,total:10,completedAt:old},201),
      change('session','resume',{ids:['新增（必刷）-1'],chapterStudy:{tests:{'all:第二章':{correct:8,total:10}}}},202),
    ]});
    const rollups=async () => {
      await db.exec('reset role');
      const result=(await scalar('select quiz_pk_private.progress_rollups($1::uuid,$2::uuid) as result',[learner,two])).result;
      await actor(learner);
      return result;
    };
    const before=await rollups();
    assert.equal(before.days[1].mine,2);assert.equal(before.days[1].mineCorrect,2);
    await rpc({account:learner,attempts:[attempt(203,'新增（必刷）-1',['A'])],changes:[
      change('session','resume',{ids:['新增（必刷）-2']},203),
      change('test','test-b',{bank:'all',chapter:'第二章',correct:9,total:10,completedAt:now},204),
    ]});
    const after=await rollups();
    assert.equal(after.days[1].mine,2);assert.equal(after.days[1].mineCorrect,2);
    assert.equal(after.days[0].mine,1);assert.equal(after.days[0].mineCorrect,0);
    assert.equal(after.tests.mine.length,2);
    assert.equal(after.tests.mine.find(x=>x.chapter==='第一章').correct,10);
    await rpc({account:learner,changes:[change('session','resume',{
      chapterStudy:{tests:{'all:第一章':{correct:1,total:10,completedAt:old-1000}}},
    },205)]});
    assert.equal((await rollups()).tests.mine.find(x=>x.chapter==='第一章').correct,10,
      'Resuming an older session must not replace a newer independently completed test.');
    await actor(one);
  });
  await t.test('old-backend fallback and v2 replay count once and prefer server grading over forged summaries', async () => {
    const learner='10000000-0000-4000-8000-000000000006';
    await db.exec('reset role');
    await db.query("insert into auth.users(id,raw_app_meta_data) values($1,'{\"quiz_enrollment\":\"direct-email-v1\"}')",[learner]);
    await actor(learner);
    await db.query('select public.merge_account_quiz_state($1::uuid,$2::jsonb)',[learner,JSON.stringify([
      change('history','新增（必刷）-1',{wrong:false,last:now,selected:['A']},301),
    ])]);
    await db.exec('reset role');
    // A migration baseline may coexist with an older-client write of this same answer.
    await db.query(`insert into quiz_sync_private.attempts(account_id,event_id,question_id,canonical_question_id,
      selected,correct,occurred_at,mode,catalog_version,source,sync_cursor)
      select account_id,gen_random_uuid(),question_id,canonical_question_id,selected,correct,occurred_at,
        mode,catalog_version,'legacy_snapshot',0 from quiz_sync_private.attempts where account_id=$1`,[learner]);
    const before=(await scalar('select quiz_pk_private.progress_rollups($1,$2) as result',[learner,two])).result;
    assert.equal(before.days[0].mine,1);
    await actor(learner);
    const result=await rpc({account:learner,attempts:[{...attempt(301,'新增（必刷）-1',['A']),correct:true}],changes:[
      change('history','新增（必刷）-1',{wrong:false,last:now,selected:['A']},302),
    ]});
    assert.equal(result.attemptRows.find(row=>row.source==='v2').correct,false);
    await db.exec('reset role');
    const after=(await scalar('select quiz_pk_private.progress_rollups($1,$2) as result',[learner,two])).result;
    assert.equal(after.days[0].mine,1);assert.equal(after.days[0].mineCorrect,0);
    assert.equal((await scalar('select count(*)::int as total from quiz_sync_private.attempts where account_id=$1',[learner])).total,3);
    const summary=(await scalar('select quiz_pk_private.study_stats($1,1685) as result',[learner])).result;
    assert.equal(summary.answered,1);assert.equal(summary.correct,0);
    await actor(learner);
    const leaderboard=(await scalar('select public.quiz_leaderboard_today() as result')).result;
    assert.equal(leaderboard.me.answered,1);
    await actor(one);
  });
  await t.test('full answerable canonical progress reaches 100% and 20 completed chapters', async () => {
    const complete='10000000-0000-4000-8000-000000000005';
    await db.exec('reset role');
    await db.query("insert into auth.users(id,raw_app_meta_data) values($1,'{\"quiz_enrollment\":\"direct-email-v1\"}')",[complete]);
    await db.query(`insert into public.quiz_state(account_id,kind,record_key,revision,change_id,payload)
      select $1,'history',question_id,$2,gen_random_uuid(),jsonb_build_object('wrong',false,'last',$2::bigint,'selected',practice_correct_options)
      from quiz_pk_private.questions where answerable and question_id=canonical_question_id`,[complete,now]);
    let summary=(await scalar('select quiz_pk_private.study_stats($1,1685) as result',[complete])).result;
    assert.equal(summary.answered,1585);assert.equal(summary.completion,100);
    const rows=(await scalar('select quiz_pk_private.progress_rollups($1,$2) as result',[complete,two])).result;
    assert.equal(rows.chapters.length,20);
    assert.equal(rows.chapters.filter(row=>row.mine===row.total).length,20);
    const alias=await scalar('select question_id,canonical_question_id from quiz_pk_private.questions where question_id<>canonical_question_id limit 1');
    await db.query(`insert into public.quiz_state(account_id,kind,record_key,revision,change_id,payload)
      values($1,'history',$2,$3,gen_random_uuid(),jsonb_build_object('wrong',true,'last',$3::bigint))`,[complete,alias.question_id,now+10]);
    summary=(await scalar('select quiz_pk_private.study_stats($1,1685) as result',[complete])).result;
    assert.equal(summary.answered,1585);assert.equal(summary.correct,1584);assert.equal(summary.completion,100);
    await actor(complete);
    const dashboard=(await scalar('select public.quiz_pk_dashboard() as result')).result;
    assert.equal(dashboard.total,1585);assert.equal(dashboard.me.completion,100);
    await actor(one);
  });
});
