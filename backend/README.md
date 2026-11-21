# 后端迁移、同步协议与本地验证

## 源码来源和迁移历史

`supabase/migrations` 包含 2026-11-21 从已确认项目的迁移历史只读恢复的 20 个真实历史版本，以及本次新增迁移。恢复过程只读取 SQL 定义、迁移版本和三个 Edge Function 的部署源码，没有读取业务用户行，也没有执行线上写入或部署。

`supabase/recovered-sources.json` 记录来源、源文件 SHA-256、仓库文件 SHA-256 和文件名映射。此前仓库 7 个 PK 文件的 SQL 与线上历史逐字节相同，但时间戳不同；现在文件名使用线上真实版本，避免 CLI 把同一历史重复应用。其余恢复文件包含账号表、RLS、账号绑定 merge RPC、注册、助教限额、开发请求、固定同桌和备注定义。

唯一历史 SQL 内容适配是 `20261120152459_quiz_fixed_desk_partner.sql`：把要求已有管理员绑定、已确认账号和唯一历史配对的 `DO` 数据切换块原样移至 `supabase/operations/20261120152459_fixed_desk_cutover.sql`。自动迁移保留 schema、函数和撤销自主配对权限；冷启动无需真实用户即可完成。manifest 明确保存适配前后不同的哈希。该 operations 文件用于理解或人工恢复既有部署，**不属于新环境的自动初始化，也不要在已完成切换的生产项目重复执行**。新环境若需要固定同桌，应由操作员在明确目标账号后单独配置；仓库不含真实账号、邮箱或绑定数据。

`supabase/functions` 恢复 `quiz-register`、`quiz-enroll` 和 `quiz-tutor` 的部署源码，保留原逻辑与依赖版本。`verify_jwt = false` 与现有函数配置一致：注册/邀请码入口有自己的授权与限额逻辑；助教调用 Auth 的 `/user` 校验 Bearer token、检查服务端允许名单，并预约数据库配额。此配置不能被解释为允许匿名调用所有业务功能。

## 运行与验证

在仓库根目录执行：

```sh
npm --prefix mobile ci
node --test backend/tests/database.test.mjs
```

测试使用 mobile 锁定的 PGlite，在内存中从零应用全部实际迁移。只有平台提供的 `auth.users`、`auth.uid()`、Storage 表和角色使用最小 stub；业务表、函数、触发器、RLS 与 grants 均来自实际 SQL。覆盖账号隔离、越权/匿名拒绝、v2 原子性、幂等冲突、分页、旧 merge、JSON null 草稿、删除、事务回滚、版本漂移、历史来源去重与统计分母。

PGlite 测试不启动网络服务，不读取环境中的生产连接信息。它不替代 PostgREST/JWT、Auth、Storage、Deno Edge Runtime 的完整集成检查，也不能模拟 PostgreSQL 多连接事务交错。正式发布前，应在独立 staging 上跑完整客户端联调和两个连接的并发同步检查。此环境未运行 Docker/Supabase 全栈。

有 Docker 的本机可使用锁定的 CLI 启动完整本地 Supabase：

```sh
mobile/node_modules/.bin/supabase start --workdir backend
mobile/node_modules/.bin/supabase db reset --local --workdir backend
```

这里的 `--local` 仅重建本地容器。仓库配置采用 PostgreSQL 17。不要为了执行测试把 CI 链接到生产项目。Edge Function 密钥由运行环境注入；变量名见 `supabase/functions/.env.example`，真实值不得提交。

## v2 同步协议

新增 RPC 为：

```text
quiz_sync_v2(expected_account uuid, changes jsonb = [], attempts jsonb = [],
             cursor bigint = 0, page_size integer = 200) -> jsonb
```

身份只取 `auth.uid()`，并要求与 `expected_account` 相同且为已登记成员。每次最多 100 个快照变更（350,000 bytes）和 100 个事件（100,000 bytes）；`page_size` 范围 1–500。错误会回滚整个事务，不返回部分 ack。

`changes` 沿用 `{kind, record_key, revision, change_id, payload}`，按 `(revision, change_id)` 比较最后版本。支持 `history`、`star`、`note`、`session`，以及独立 `draft`、`test`。key 长度 1–160，无 UUID 限定；新任务可用 UUID，迁移成绩可用 `legacy:<bank>:<chapter>`。draft 的显式 JSON `null` 表示关闭草稿；其余 draft/test 值为对象。新的 merge 实现保留 JSON null，缺失 payload 仍拒绝。

`attempts` 使用以下字段：

```json
{
  "event_id": "客户端生成并持久化的 UUID",
  "question_id": "展示题的原始 ID",
  "selected": ["A", "C"],
  "occurred_at": 1795219200000,
  "mode": "practice",
  "catalog_version": "content/questions.json 字节的 SHA-256"
}
```

`mode` 只允许 `practice`、`chapter-test`、`review`。selected 是展示题的选项字母，服务端排序、校验范围/重复并按指定不可变题库版本判分，不采用客户端提交的 correct 或 canonical ID。相同账号/event_id/原始内容的重试幂等；相同 ID 改写内容报 `quiz_attempt_conflict`。未知题、不可答题或未部署的 catalog_version 报 `quiz_catalog_unavailable`；客户端保留事件并提示等待后端题库升级，不能删除队列或改写事件 ID 来绕过错误。

响应包含 `version: 2`、`ack: {changes: [change_id], attempts: [event_id]}`、`rows`、`attemptRows`、`next_cursor`、`has_more`、`high_watermark`。rows 包含原有快照字段及 sync_cursor；物理删除产生 `deleted: true, payload: null` 的墓碑。attemptRows 返回原始上传字段与服务端 canonical_question_id/correct/received_at/source/sync_cursor。ack 确认上传已持久化或被更新的快照版本覆盖；被 ack 的最新快照可能在后续分页中返回。客户端必须在同一本地事务内提交本页数据、移除相应 ack、保存 cursor。

rows 和 attemptRows 共用一个单调游标流，分页上限是二者总数。`has_more` 时 next_cursor 是本页实际送达的最大值；最后一页可以前进到本事务 high_watermark。snapshot 只保留每个 key 的最新版本，拉取者不需要看到被覆盖的中间快照；attempt 则追加保存。cursor 大于当前账户的时钟报 `quiz_cursor_ahead`，客户端可清零拉取一次。游标必须按账号隔离。

### 并发安全

游标来自可回滚的每账号 clocks 行，而不是全局 `nextval()`。v2、兼容 merge 和状态触发器都使用同一账号事务级 advisory lock；旧客户端或直接表 upsert 也必须经过触发器。锁保持到提交后，因此不会出现低序号事务尚未提交、另一拉取先确认高序号，随后永远跳过低序号的情况。修改与删除都有游标，事务回滚连游标推进一起回滚。若额外客户端绕过 merge 直接修改行，数据库可能选择中止竞争造成的死锁；调用方应重试整个事务，不能提前 ack。

## 统计口径与兼容边界

当前题库原始记录 1685，canonical 题 1682，可作答 canonical 题 1585；97 道填空仅阅读。完成率、章节和题型分母统一使用可作答 canonical 题。同一个别名题的最后作答只占一个进度位置；全答可达到 100% 和 20/20 章节。

近 7 天图表按追加 attempt 次数统计；每日任务、当日练习和排行榜按当日 distinct canonical 题数统计，多次复习不会刷高当日题数。客户端使用毫秒时间，日界统一为 Asia/Shanghai。重新做题不会抹掉前一天事件。

迁移仅能从旧数据恢复每题最后一条已知快照，source 为 `legacy_snapshot`；旧客户端之后写入的可识别作答，以及升级客户端首次上传的遗留待同步快照，在缺少对应 v2 事件时记为 `legacy_sync`；v2 原始事件为 `v2`。历史缺失的每次作答无法重建，不能声称迁移前图表完整。统计投影在同账号、canonical 题、occurred_at 相同时优先采用 v2，剔除对应 legacy 观测；没有 v2 时同一时刻的多个 legacy 观测只计一次。原始记录保留不删。多个真实 v2 event_id 即便同毫秒也各计一次。

掌握情况优先采用与当前快照同题同时间的 v2 服务端判分。没有该证据的兼容快照仍使用旧 wrong 值，legacy 来源的正确性不可追溯验证。独立 test 成绩是学习反馈，不是服务端受监考考试成绩或竞技胜负依据；completedAt 优先于 session 更新时间，没有真实时间的旧成绩只能以 revision 作为兼容观测时间。客户端时间和作答请求本身也不是反作弊证据；可离线练习题的答案随客户端发布。

## 更新题库与发布顺序

前后端共用 `content/questions.json` 和 `web/scripts/question-catalog.js` 的 canonicalRows。生成器以内容文件原始字节计算版本，补齐全部可答题的练习判分，并保存不可变版本供离线旧客户端同步。

先用 CLI 新建迁移，再把生成 SQL 写入**刚创建的新文件**：

```sh
mobile/node_modules/.bin/supabase migration new question_catalog --workdir backend
node backend/tools/catalog-sql.cjs content/questions.json > backend/supabase/migrations/新生成的时间戳_question_catalog.sql
node --test backend/tests/database.test.mjs
```

不要覆盖已部署的历史迁移。测试要求至少一个已提交 SQL 包含当前内容精确生成结果，并核对数据库版本及 canonical map，防止只改前端而忘记后端。

现有在线玩法资格保持 1157 题；新补齐的练习题不会自动扩展 PK/同桌/竞技场覆盖范围。`live_enabled`（含传统 PK）与 `arena_enabled` 是显式开关；生成器会关闭已删除题或答案/选项变化题的旧资格，保留既有游戏选项。扩充玩法需单独审核并迁移对应 options/correct_options 与资格，避免在途房间答案被意外改变。

现有项目需先核对迁移 history 与 manifest，再在 staging 验证本次三个新增版本；恢复的历史文件不应重新执行。生产发布由维护者审查迁移计划后执行，本次没有远程 apply。客户端先探测 quiz_sync_v2；旧后端 PGRST202 时继续四种 legacy 快照同步，draft/test/attempt 保留本地待确认。部署后端与当前题库版本后，再完成 v2 同步验证。将来内容版本更新应先部署后端 catalog migration，再发布客户端。
