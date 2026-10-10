import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * Nexus Agent Core — SQLite 约束回归（Stage 0 spike 1 的一部分）
 *
 * 验证 DESIGN.md §8.5 / §8.6 / §6.3 依赖的四条 SQLite 行为。这些结论直接决定
 * grant 轮换事务的写法，踩错会在运行期变成"授权 A、执行 B"或"新授权签不出来"。
 *
 *   1. 非 deferred self-FK 时，grant 轮换的两种自然顺序都失败；
 *   2. self-FK 改 DEFERRABLE INITIALLY DEFERRED 后可行；
 *   3. 先 revoked_at 退休旧行同样可行（不依赖 deferred）；
 *   4. 已过期但未显式退休的 grant 仍占着部分唯一索引的槽位
 *      —— 部分索引谓词引用不了"当前时间"，所以签发事务必须先显式退休过期行；
 *   5. execution → action_grants 的四列复合外键能挡住"绑 action B、用 A 的 grant"；
 *   6. 唯一索引里的 NULL 互不相等——decision 幂等键若允许 session_key 为 NULL 会直接失效；
 *   7. run_triggers 的"首次写入不可变"（ON CONFLICT DO NOTHING）与新鲜度过滤；
 *   8. outbox 认领 CAS 与 action_executions_prepared 部分唯一索引；
 *   9. run_triggers 用 (owner_id, run_id) 复合主键后，不同 owner 的同名 run 互不遮挡；
 *  10. core approval 的 attempted 租约必须盖住审批超时，终态不可再 claim；
 *  11. DESIGN.md §6.3 的 schema 能真正建库，且符合 §4.1 的命名契约；
 *  12. 偏好表（§11）的承诺由 schema 兜住：投影与 append-only 历史同事务写、
 *      同 (scope,key) 三种 origin 并存但同 origin 只能有一条活行，以及四条 origin
 *      不变量 CHECK 的负例（stated 带 task_id、exception 缺 task_id、observed 缺
 *      confidence / 缺 source_note、非 observed 带 confidence）；
 *  13. decisions.effect_kind 的行内 CHECK **以及跨表隔断**——授权两表用一条七列复合
 *      外键只能引用"effect 对得上、已 decided、approved、且绑的正是 chosen_action_id"
 *      的决策，chosen 自己又复合引用 decision_actions（§8.12）；evidence 的来源身份去重、tool_output 的 run/session 作用域、
 *      "只统计当前有效支撑、反证单独算"的计数（§9.5.3/§9.5.4）；
 *      purge 回执的互斥形状；偏好 actor 与 origin 的组合约束；两张授权表绑定的 action
 *      必须等于 decisions.chosen_action_id，而且那条决策必须 decided+approved
 *      （pending / denied / effect_apply_failed 三种状态都签不出 grant，两类 grant
 *      各跑一遍同一个矩阵）；证据投影的 head 事件不能跨 claim；blob_reservations 的回收状态机
 *      约束（reclaiming 必带认领者与租期、同 owner 同 content_hash 只能有一个在世
 *      持有者、GC 认领后阶段 B 的 CAS 改不到行）、不级联因而挡住 DELETE nexus_tasks、
 *      以及配额计数口径；
 *  14. blob_objects 的 generation 寻址、租期与引用所有权。**只证 schema 形状与
 *      同事务原子性**：同一 content_hash 同时只能有一个未删除的 generation（物理 key
 *      因此永不复用）、writing 必带 writer 租期且租期过期后能走
 *      writing→reclaiming→deleted→缺失证明、new_object 与 attach_live_object 两支的
 *      "状态转移 + evidence + ref_count"都在一个事务里完成且中途失败一起回滚、
 *      ref_count>0 进不了 reclaiming、带 claim 关联的 evidence 删不掉（所以 purge 的
 *      P3 只能摘 blob_key）、缺失证明只能出现在墓碑上、evidence 的 content_hash
 *      必须与物理对象一致；缺失证明必须带 settled writer（writing 须记 incarnation，
 *      writing→live/reclaiming 同事务抄入 settled_*）、证明可原子失效再重签；
 *      purge_work_items 的终态与 disposition 对应、P3 同事务；ref_count 漂移 schema 拦
 *      不住、但带重算的回收更新拒绝漂移对象；purge_runs（一个 Task 一个 run、封口三元组、
 *      P5 前置对空集合/数量不符不放行）、工作项四列外键、disposition 双向可改、
 *      作废缺失证明只清 absence_verified_*、process_incarnations 单一当前行；
 *      v0.12k：P5 前置带 proof token（终态工作项的证明被作废后不放行）、reservation 来源
 *      工作项与 item_count 口径、principal-first 的 P5 查询、同进程 reload 不被误标 gone；
 *      v0.12l：P4 终态条件更新与证明作废的两种交错（+无条件写的对照与兜底枚举）、P2 ① 按
 *      对象聚合的幂等重入、process_boot_id 来源（候选 D：pid + 启动时间）的组合规则（Node 级，不是 OpenClaw 行为）；
 *      v0.12n：没有'至多一个当前'唯一索引——真实 SIGKILL 崩溃后新 incarnation 照常登记、旧行被
 *      supersede；同 boot id 的同进程前任不被误标且不阻塞新登记。
 *      **不证**真实的异步时序（A2 迟到、GC 与阶段 B 抢同一条、purge 的 P1–P5 推进、
 *      缺失证明的实际成立）——那些归 Stage 3 的真实入口测试。
 *
 * 口径提醒（别把这个脚本当成协议证明）：第 13 组里凡是直接 UPDATE
 * claim_evidence_links 的几条，证明的只是"计数 SQL 会按 relation/effective 过滤行",
 * **不证明** detach / supersede 会正确追加链接事件、更新投影并重算 claim 状态
 * ——那是 §9.5.5 的写入协议，必须由 Stage 3 的真实入口测试覆盖。
 * 同理，blob store 的容量与 namespace 命名契约（§9.4）不属于 SQLite schema，
 * 由 Stage 0 的 blob runtime spike 调真实 openBlobStore 验证，别往这个脚本里塞。
 * 回收与 purge 也一样：这里证的是 CAS 与外键**形状**，
 * "GC 与阶段 B 并发谁赢"、"purge 返回成功时字节真的没了"必须由 Stage 3 的
 * 真实 blob store + 真实 store 入口测试覆盖（§13 Stage 3 已列出七条交错）。
 *
 * 第 11 组与前十组不同：它**不自己手写 schema**，而是从 DESIGN.md 里抽出
 * §6.3 那个 ```sql 块原样执行。所以文档里的 schema 一旦写错（语法、STRICT 类型、
 * 悬空外键、表名退回 journey*），这一组会直接红。Stage 1 建表之后，把
 * SCHEMA_SOURCE 从"文档块"换成生产 migration 即可，断言不用动。
 *
 * 用法：node extensions/nexus-agent-core/spikes/grant-rotation-sqlite.mjs
 * 退出码非 0 表示有结论发生了变化（SQLite 升级或 schema 改动），需要回头核对 DESIGN.md。
 *
 * Stage 1 建表之后，这个文件应该被改写成插件包内的 vitest contract test；
 * 现在插件包还不存在，先以独立脚本形式保留，避免被 extensions 的 vitest 收集。
 */
import { DatabaseSync } from "node:sqlite";

const ROTATION_SCHEMA = (deferred) => `
CREATE TABLE action_grants (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL, action_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER, revoked_at INTEGER, superseded_by TEXT,
  UNIQUE (owner_id, task_id, id),
  UNIQUE (owner_id, task_id, action_id, id),
  FOREIGN KEY (owner_id, task_id, superseded_by)
    REFERENCES action_grants(owner_id, task_id, id)${deferred ? " DEFERRABLE INITIALLY DEFERRED" : ""}
) STRICT;
CREATE UNIQUE INDEX action_grants_live ON action_grants(owner_id, action_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL AND superseded_by IS NULL;
`;

const FAR_FUTURE = 9_999_999_999;
const results = [];

function openDb(schema) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  // 回读断言：foreign_keys 是 per-connection 的，默认 OFF
  const [{ foreign_keys: fk }] = db.prepare("SELECT * FROM pragma_foreign_keys()").all();
  assert.equal(fk, 1, "PRAGMA foreign_keys 没有生效");
  db.exec(schema);
  return db;
}

function seedLiveGrant(db, { id = "G1", expiresAt = FAR_FUTURE } = {}) {
  db.prepare("INSERT INTO action_grants VALUES (?,'o1','T7','A1',?,NULL,NULL,NULL)").run(
    id,
    expiresAt,
  );
}

/** 在一个事务里跑若干语句，返回 {ok} 或 {ok:false, error}。 */
function inTransaction(db, statements) {
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const sql of statements) db.exec(sql);
    db.exec("COMMIT");
    return { ok: true };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务可能已被自动回滚 */
    }
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function check(name, actual, expectation) {
  const pass = expectation(actual);
  results.push({ name, pass, actual });
  console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}`);
  if (!pass) console.log(`        实际: ${JSON.stringify(actual)}`);
}

console.log(`node:sqlite — 开始 Nexus grant 约束回归\n`);

// ---- 1. 非 deferred：两种顺序都失败 ----
console.log("[1] 非 deferred self-FK 下的轮换顺序");
{
  const db = openDb(ROTATION_SCHEMA(false));
  seedLiveGrant(db);
  const r = inTransaction(db, [
    "INSERT INTO action_grants VALUES ('G2','o1','T7','A1',9999999999,NULL,NULL,NULL)",
    "UPDATE action_grants SET superseded_by='G2' WHERE id='G1'",
  ]);
  check(
    "先插新 grant → 撞 action_grants_live 部分唯一索引",
    r,
    (x) => !x.ok && /UNIQUE constraint failed/i.test(x.error),
  );
  db.close();
}
{
  const db = openDb(ROTATION_SCHEMA(false));
  seedLiveGrant(db);
  const r = inTransaction(db, [
    "UPDATE action_grants SET superseded_by='G2' WHERE id='G1'",
    "INSERT INTO action_grants VALUES ('G2','o1','T7','A1',9999999999,NULL,NULL,NULL)",
  ]);
  check(
    "先标旧 grant → 撞 self-FK 立即检查",
    r,
    (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
  );
}

// ---- 2. deferred self-FK 可行 ----
console.log("\n[2] deferred self-FK");
{
  const db = openDb(ROTATION_SCHEMA(true));
  seedLiveGrant(db);
  const r = inTransaction(db, [
    "UPDATE action_grants SET superseded_by='G2' WHERE id='G1'",
    "INSERT INTO action_grants VALUES ('G2','o1','T7','A1',9999999999,NULL,NULL,NULL)",
  ]);
  check("先标旧行、再插新行、提交时统一检查 → 成功", r, (x) => x.ok);
  db.close();
}

// ---- 3. 先 revoked_at 退休旧行（不依赖 deferred） ----
console.log("\n[3] 先 revoked_at 退休旧行");
{
  const db = openDb(ROTATION_SCHEMA(false));
  seedLiveGrant(db);
  const r = inTransaction(db, [
    "UPDATE action_grants SET revoked_at=1 WHERE id='G1'",
    "INSERT INTO action_grants VALUES ('G2','o1','T7','A1',9999999999,NULL,NULL,NULL)",
    "UPDATE action_grants SET superseded_by='G2' WHERE id='G1'",
  ]);
  check("退休 → 插入 → 回填 → 成功", r, (x) => x.ok);
  db.close();
}

// ---- 4. 过期但未退休的 grant 仍占 live 槽位 ----
console.log("\n[4] 过期 grant 的 live 槽位（部分索引看不见 now）");
{
  const db = openDb(ROTATION_SCHEMA(true));
  seedLiveGrant(db, { expiresAt: 1 }); // 早已过期
  const blocked = inTransaction(db, [
    "INSERT INTO action_grants VALUES ('G2','o1','T7','A1',9999999999,NULL,NULL,NULL)",
  ]);
  check(
    "已过期但未退休 → 仍然挡住新 grant",
    blocked,
    (x) => !x.ok && /UNIQUE constraint failed/i.test(x.error),
  );

  const afterRetire = inTransaction(db, [
    "UPDATE action_grants SET revoked_at=1 WHERE id='G1' AND expires_at <= 1000",
    "INSERT INTO action_grants VALUES ('G2','o1','T7','A1',9999999999,NULL,NULL,NULL)",
  ]);
  check("显式退休过期行之后 → 可以签发", afterRetire, (x) => x.ok);
  db.close();
}

// ---- 5. execution → grant 四列复合外键 ----
console.log("\n[5] execution 与 grant 的 action 一致性");
{
  const db = openDb(`
    ${ROTATION_SCHEMA(true)}
    CREATE TABLE action_executions (
      id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
      action_id TEXT NOT NULL, action_grant_id TEXT,
      UNIQUE (owner_id, task_id, id),
      FOREIGN KEY (owner_id, task_id, action_id, action_grant_id)
        REFERENCES action_grants(owner_id, task_id, action_id, id)
    ) STRICT;
  `);
  seedLiveGrant(db, { id: "GA1" }); // action A1
  db.prepare("INSERT INTO action_grants VALUES ('GA2','o1','T7','A2',?,NULL,NULL,NULL)").run(
    FAR_FUTURE,
  );

  const legit = inTransaction(db, [
    "INSERT INTO action_executions VALUES ('E1','o1','T7','A1','GA1')",
  ]);
  check("execution.action = grant.action → 允许", legit, (x) => x.ok);

  const crossed = inTransaction(db, [
    "INSERT INTO action_executions VALUES ('E2','o1','T7','A2','GA1')",
  ]);
  check(
    "execution 绑 A2 却用 A1 的 grant → 被外键拒绝",
    crossed,
    (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
  );
  db.close();
}

// ---- 6. 唯一索引中的 NULL：decision 幂等键 ----
console.log("\n[6] 唯一索引里的 NULL（decision 幂等键）");
{
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
      session_key TEXT, run_id TEXT, tool_call_id TEXT) STRICT;
    CREATE UNIQUE INDEX decisions_toolcall_bad
      ON decisions(owner_id, session_key, run_id, tool_call_id)
      WHERE tool_call_id IS NOT NULL AND run_id IS NOT NULL;
  `);
  const ins = db.prepare("INSERT INTO decisions VALUES (?,?,?,?,?)");
  ins.run("D1", "o1", null, "r1", "call_1");
  let dupAllowed = false;
  try {
    ins.run("D2", "o1", null, "r1", "call_1");
    dupAllowed = true;
  } catch {
    /* 被拒 */
  }
  check("session_key 为 NULL 时唯一索引拦不住重复 → 幂等键失效", dupAllowed, (x) => x === true);

  ins.run("D3", "o1", "s1", "r1", "call_1");
  let dupWithSession = false;
  try {
    ins.run("D4", "o1", "s1", "r1", "call_1");
    dupWithSession = true;
  } catch {
    /* 被拒 */
  }
  check("session_key 非空时同键重复被拒", dupWithSession, (x) => x === false);

  // 修正后的谓词
  db.exec(`
    DROP INDEX decisions_toolcall_bad;
    DELETE FROM decisions;
    CREATE UNIQUE INDEX decisions_toolcall
      ON decisions(owner_id, session_key, run_id, tool_call_id)
      WHERE tool_call_id IS NOT NULL AND run_id IS NOT NULL AND session_key IS NOT NULL;
  `);
  ins.run("D5", "o1", null, "r1", "call_1");
  let stillAllowed = false;
  try {
    ins.run("D6", "o1", null, "r1", "call_1");
    stillAllowed = true;
  } catch {
    /* 被拒 */
  }
  check(
    "加上 session_key IS NOT NULL 后，NULL 行不再进索引（所以代码侧必须 fail closed）",
    stillAllowed,
    (x) => x === true,
  );
  db.close();
}

// ---- 7. run_triggers：首次写入不可变 + 新鲜度（正式 schema） ----
console.log("\n[7] run_triggers 不可变与新鲜度");
{
  const db = new DatabaseSync(":memory:");
  // DESIGN.md §6.3 的正式定义：复合主键。单列主键的负例在第 9 组。
  db.exec(`
    CREATE TABLE run_triggers (
      run_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      trigger TEXT NOT NULL, session_key TEXT NOT NULL,
      job_id TEXT, watch_id TEXT,
      recorded_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY (owner_id, run_id)) STRICT;
  `);
  const record = db.prepare(
    `INSERT INTO run_triggers VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(owner_id, run_id) DO NOTHING`,
  );
  record.run("run1", "o1", "cron", "s1", "job1", "w1", 1000, 5000);
  record.run("run1", "o1", "user", "s1", null, null, 1100, 5100); // 后续 attempt 想改写
  const row = db.prepare("SELECT trigger FROM run_triggers WHERE run_id='run1'").get();
  check(
    "ON CONFLICT DO NOTHING → 后续 attempt 改写不了 cron→user",
    row.trigger,
    (x) => x === "cron",
  );

  const lookup = db.prepare(
    `SELECT trigger FROM run_triggers
      WHERE run_id=? AND owner_id=? AND session_key=? AND expires_at > ?`,
  );
  check("owner 不匹配 → 查不到", lookup.get("run1", "o2", "s1", 2000), (x) => x === undefined);
  check("session 不匹配 → 查不到", lookup.get("run1", "o1", "s9", 2000), (x) => x === undefined);
  check("已过期 → 查不到", lookup.get("run1", "o1", "s1", 9000), (x) => x === undefined);
  check(
    "主体/会话/新鲜度都对 → 查得到",
    lookup.get("run1", "o1", "s1", 2000)?.trigger,
    (x) => x === "cron",
  );
  db.close();
}

// ---- 8. outbox 认领 CAS 与 prepared execution 唯一性 ----
console.log("\n[8] outbox 认领 CAS 与 prepared execution 唯一性");
{
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE outbox (
      id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, event_key TEXT NOT NULL,
      state TEXT NOT NULL, claimed_by TEXT, claimed_at INTEGER,
      next_attempt_at INTEGER NOT NULL,
      UNIQUE (owner_id, event_key)) STRICT;
    CREATE TABLE action_executions (
      id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL,
      action_id TEXT NOT NULL, standing_grant_id TEXT, state TEXT NOT NULL) STRICT;
    CREATE UNIQUE INDEX action_executions_prepared
      ON action_executions(owner_id, action_id, standing_grant_id)
      WHERE state = 'prepared' AND standing_grant_id IS NOT NULL;
  `);
  db.prepare(
    "INSERT INTO outbox VALUES ('O1','o1','decision_pending:D1','pending',NULL,NULL,0)",
  ).run();
  let dupEvent = false;
  try {
    db.prepare(
      "INSERT INTO outbox VALUES ('O2','o1','decision_pending:D1','pending',NULL,NULL,0)",
    ).run();
    dupEvent = true;
  } catch {
    /* 被拒 */
  }
  check("同一 event_key 重复入队被拒（enqueue 幂等）", dupEvent, (x) => x === false);

  const claim = db.prepare(
    `UPDATE outbox SET state='delivering', claimed_by=?, claimed_at=?
      WHERE id='O1' AND state='pending' AND next_attempt_at <= ?
     RETURNING id`,
  );
  const w1 = claim.all("worker-1", 100, 100);
  const w2 = claim.all("worker-2", 100, 100);
  check(
    "两个投递器并发认领 → 只有一个拿到",
    [w1.length, w2.length],
    (x) => x[0] === 1 && x[1] === 0,
  );

  const prep = db.prepare("INSERT INTO action_executions VALUES (?,?,?,?,'prepared')");
  prep.run("E1", "o1", "A1", "SG1");
  let dupPrepared = false;
  try {
    prep.run("E2", "o1", "A1", "SG1");
    dupPrepared = true;
  } catch {
    /* 被拒 */
  }
  check(
    "同 action + 同 standing grant 第二条 prepared execution 被拒",
    dupPrepared,
    (x) => x === false,
  );

  db.prepare("UPDATE action_executions SET state='succeeded' WHERE id='E1'").run();
  let afterTerminal = false;
  try {
    prep.run("E3", "o1", "A1", "SG1");
    afterTerminal = true;
  } catch {
    /* 被拒 */
  }
  check(
    "前一条进终态后，索引不再拦截（所以终态拒绝要由代码实现，见 §8.6）",
    afterTerminal,
    (x) => x === true,
  );
  db.close();
}

// ---- 9. run_triggers 的 owner 隔离 ----
console.log("\n[9] run_triggers 的 owner 隔离（含旧单列主键负例对照）");
{
  const mk = (pk) => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE run_triggers (
        run_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        trigger TEXT NOT NULL, session_key TEXT NOT NULL,
        recorded_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        ${pk}) STRICT;
    `);
    return db;
  };
  const insert = (db) =>
    db.prepare(
      `INSERT INTO run_triggers VALUES (?,?,?,?,?,?)
         ON CONFLICT(${db.__pk}) DO NOTHING`,
    );

  // 单列主键：owner2 的同名 run 被静默吞掉
  const bad = mk("PRIMARY KEY (run_id)");
  bad.__pk = "run_id";
  insert(bad).run("run1", "o1", "cron", "s1", 0, 9999);
  insert(bad).run("run1", "o2", "user", "s2", 0, 9999);
  const badRows = bad.prepare("SELECT owner_id, trigger FROM run_triggers").all();
  check(
    "单列主键 → owner2 的同名 run 写不进去（会被错判成非 user turn）",
    badRows.length,
    (x) => x === 1,
  );
  bad.close();

  // 复合主键：两个 owner 各自独立
  const good = mk("PRIMARY KEY (owner_id, run_id)");
  good.__pk = "owner_id, run_id";
  insert(good).run("run1", "o1", "cron", "s1", 0, 9999);
  insert(good).run("run1", "o2", "user", "s2", 0, 9999);
  const goodRows = good
    .prepare("SELECT owner_id, trigger FROM run_triggers ORDER BY owner_id")
    .all();
  check(
    "复合主键 → 两个 owner 的同名 run 各写各的",
    goodRows.map((r) => r.trigger),
    (x) => x.length === 2 && x[0] === "cron" && x[1] === "user",
  );

  const lookup = good.prepare(
    `SELECT trigger FROM run_triggers
      WHERE run_id=? AND owner_id=? AND session_key=? AND expires_at > ?`,
  );
  check("owner1 读不到 owner2 的那条", lookup.get("run1", "o1", "s2", 100), (x) => x === undefined);
  check(
    "各自读各自的",
    [lookup.get("run1", "o1", "s1", 100)?.trigger, lookup.get("run1", "o2", "s2", 100)?.trigger],
    (x) => x[0] === "cron" && x[1] === "user",
  );

  // 不可变：同复合键重写不生效
  insert(good).run("run1", "o1", "user", "s1", 0, 9999);
  check(
    "同 (owner, run) 重写不生效（cron 不会被改成 user）",
    lookup.get("run1", "o1", "s1", 100)?.trigger,
    (x) => x === "cron",
  );
  good.close();
}

// ---- 10. core approval 租约：租期必须盖住审批超时 ----
console.log("\n[10] core approval 租约与审批超时");
{
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      core_approval_state TEXT NOT NULL DEFAULT 'not_attempted',
      core_approval_attempt_at INTEGER, core_approval_attempt_id TEXT) STRICT;
  `);
  db.prepare(
    "INSERT INTO decisions VALUES ('D1','o1','T7','pending','not_attempted',NULL,NULL)",
  ).run();
  const claim = db.prepare(
    `UPDATE decisions
        SET core_approval_state='attempted', core_approval_attempt_at=?, core_approval_attempt_id=?
      WHERE owner_id='o1' AND task_id='T7' AND id='D1' AND status='pending'
        AND (core_approval_state='not_attempted'
             OR (core_approval_state='attempted' AND core_approval_attempt_at < ? - ?))
     RETURNING core_approval_attempt_id`,
  );
  const APPROVAL_TIMEOUT = 600_000;
  const LEASE = APPROVAL_TIMEOUT + 60_000;

  check("首次 claim 成功", claim.all(1_000_000, "att-1", 1_000_000, LEASE).length, (x) => x === 1);

  // v0.8 的 90s 租期：卡还在等用户就被重新 claim
  const BAD_LEASE = 90_000;
  const at90s = 1_000_000 + 120_000;
  check(
    "90s 租期 → 卡仍 pending 时被重新 claim（v0.8 的 bug）",
    claim.all(at90s, "att-2", at90s, BAD_LEASE).length,
    (x) => x === 1,
  );

  // 重置后用正确租期
  db.prepare(
    "UPDATE decisions SET core_approval_state='attempted', core_approval_attempt_at=1000000, core_approval_attempt_id='att-1'",
  ).run();
  check(
    "660s 租期 → 同一时刻不会重挂",
    claim.all(at90s, "att-3", at90s, LEASE).length,
    (x) => x === 0,
  );
  const afterLease = 1_000_000 + LEASE + 1;
  check(
    "超过租期（崩溃兜底）→ 允许重新接管",
    claim.all(afterLease, "att-4", afterLease, LEASE).length,
    (x) => x === 1,
  );

  // 终态不参与重新 claim
  db.prepare("UPDATE decisions SET core_approval_state='resolved'").run();
  check(
    "终态 resolved → 不再 claim",
    claim.all(afterLease + 1, "att-5", afterLease + 1, LEASE).length,
    (x) => x === 0,
  );

  // attempt token：迟到的旧回调认不出来
  const current = db.prepare("SELECT core_approval_attempt_id AS id FROM decisions").get();
  check("当前 attempt token 是最后一次 claim 的，旧回调比对不上", current.id, (x) => x === "att-4");
  db.close();
}

// ---- 11. DESIGN.md 的 schema 能建库，且符合命名契约 ----
// 前十组用的是裁剪过的最小表，只能验证约束语义。这一组把 DESIGN.md §6.3 的
// SQL 原样跑一遍——它是现阶段 schema 的唯一真相，所以这组是真正的漂移闸门，
// 而不是自己写 fixture 再检查自己。
//
// ⚠ 口径：主体证明的是"**文档里的 schema** 符合契约"。Stage 1 的生产迁移
// （src/store/schema.ts）已落地：开头四条检查证它与文档逐字一致、单独建库干净、
// 后续阶段只靠追加表就能叠上去。其余断言还没有换成执行生产迁移。
console.log("\n[11] DESIGN.md 的 schema 与命名契约");
{
  const designPath = new URL("../DESIGN.md", import.meta.url);
  const readSchemaSource = () => {
    const md = fs.readFileSync(designPath, "utf8");
    const blocks = [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
    const schema = blocks.filter((b) => b.includes("CREATE TABLE nexus_tasks"));
    assert.equal(schema.length, 1, "DESIGN.md 里应恰好有一个建表 SQL 块");
    return schema[0];
  };

  let db;
  let openError;
  try {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(readSchemaSource());
  } catch (error) {
    openError = String(error?.message ?? error);
  }
  check("DESIGN.md §6.3 的 schema 可以原样建库", openError ?? "ok", (x) => x === "ok");

  // ---- Stage 1 分批建表（DESIGN §13 Stage 1「首发表范围」，2026-10-10）：生产迁移 src/store/schema.ts 是
  // 第一个"落地的 schema"。这里证三件事：① 它与 DESIGN §6.3 的三张 Task 表逐字一致；② 单独建库干净
  // （只有三张表、foreign_key_check 为空）；③ 之后的阶段只靠"追加表"就能到达完整 schema，
  // 不需要 ALTER 已发布的表。
  {
    const schemaTs = fs.readFileSync(new URL("../src/store/schema.ts", import.meta.url), "utf8");
    const m = schemaTs.match(/STAGE1_TASK_CORE_SQL = `\n([\s\S]*?)\n`;/);
    const migrationSql = m ? m[1].replaceAll("\\`", "`").replaceAll("\\${", "${") : "";
    const md = readSchemaSource();
    const startMarker = "---------- L3 目标 ----------";
    const endMarker = "---------- 候选动作";
    const a = md.indexOf(startMarker);
    const b = md.indexOf(endMarker);
    check(
      "Stage 1 迁移 SQL 与 DESIGN §6.3 的三张 Task 表逐字一致",
      [a >= 0 && b > a, migrationSql.trim() === md.slice(a + startMarker.length, b).trim()],
      (x) => x[0] === true && x[1] === true,
    );

    const names = (conn) =>
      conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name);
    const staged = new DatabaseSync(":memory:");
    staged.exec("PRAGMA foreign_keys = ON;");
    staged.exec(migrationSql);
    check(
      "Stage 1 迁移单独建库：恰好三张 Task 表，foreign_key_check 为空",
      [names(staged), staged.prepare("PRAGMA foreign_key_check").all().length],
      (x) =>
        JSON.stringify(x[0]) ===
          JSON.stringify(["nexus_task_sessions", "nexus_task_steps", "nexus_tasks"]) && x[1] === 0,
    );

    const fullTables = (() => {
      const full = new DatabaseSync(":memory:");
      full.exec("PRAGMA foreign_keys = ON;");
      full.exec(md);
      return names(full);
    })();
    // 后续阶段 = 完整 schema 去掉 Stage 1 那一段，叠加在已发布的 Stage 1 库上。
    let appended;
    try {
      staged.exec(md.slice(0, a) + md.slice(b));
      appended = "ok";
    } catch (error) {
      appended = String(error?.message ?? error);
    }
    check(
      "Stage 2–4 的表只靠追加就能叠到 Stage 1 库上（不 ALTER 已发布的表）",
      appended,
      (x) => x === "ok",
    );
    check(
      "叠加后的表集合与完整 schema 一致，foreign_key_check 为空",
      [names(staged), staged.prepare("PRAGMA foreign_key_check").all().length],
      (x) => JSON.stringify(x[0]) === JSON.stringify(fullTables) && x[1] === 0,
    );
  }

  if (db && !openError) {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);

    // §4.1 规则第二行：Task 聚合根及其直接组成表固定用 nexus_task*
    const TASK_TABLES = [
      "nexus_tasks",
      "nexus_task_steps",
      "nexus_task_sessions",
      "nexus_task_completion_claims",
    ];
    check(
      "四张 Task 聚合表齐全（漏一张即红）",
      TASK_TABLES.filter((n) => tables.includes(n)),
      (x) => x.length === TASK_TABLES.length,
    );
    check(
      "没有多余的 nexus_task* 表（新增需同步 §4.1 与本断言）",
      tables.filter((n) => n.startsWith("nexus_task")).length,
      (x) => x === TASK_TABLES.length,
    );
    check(
      "旧的 Journey 表名不存在",
      tables.some((n) => n.toLowerCase().includes("journey")),
      (x) => x === false,
    );
    check(
      "插件私有辅助表不带前缀",
      [
        "actions",
        "decisions",
        "action_grants",
        "standing_grants",
        "action_executions",
        "grant_uses",
        "claims",
        "claim_events",
        "claim_event_evidence",
        "evidence",
        "watches",
        "outbox",
        "run_triggers",
        "purge_receipts",
        "preferences",
        "preference_revisions",
        "decision_actions",
        "claim_evidence_links",
        "blob_reservations",
      ].every((n) => tables.includes(n)),
      (x) => x === true,
    );

    // 外键目标必须都解析得到。SQLite 在 CREATE TABLE 时不校验父表是否存在，
    // 打错一个表名要等到第一次 DML 才炸；而 PRAGMA foreign_key_check 在**空库**上
    // 没有行可查，同样发现不了（实测：把父表名改成 nexus_taks 它照样返回 0 行）。
    // 所以这里逐表读 foreign_key_list，自己确认每个父表都在 sqlite_master 里。
    const danglingFks = [];
    for (const table of tables) {
      for (const fk of db.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
        const parentExists = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
          .get(fk.table);
        if (!parentExists) danglingFks.push(`${table} -> ${fk.table}`);
      }
    }
    check("没有悬空外键：每个父表都存在", danglingFks, (x) => x.length === 0);

    // 上面那一遍只看父**表**在不在。父表在、但父**列**拼错或父键不唯一时，
    // foreign_key_list 照样返回一条看起来正常的记录，扫描发现不了。
    // 这种情况 PRAGMA foreign_key_check 会**抛** "foreign key mismatch"（不是返回行），
    // 所以必须 try/catch。两遍互补，缺一不可：
    //   父表不存在      → foreign_key_check 返回 0 行；父表扫描抓到
    //   父列不存在      → 父表扫描返回 0 条；foreign_key_check 抛异常
    //   父列存在但不唯一 → 父表扫描返回 0 条；foreign_key_check 抛异常
    let fkMismatch;
    try {
      const rows = db.prepare("PRAGMA foreign_key_check").all();
      fkMismatch = rows.length === 0 ? "ok" : `foreign_key_check 返回 ${rows.length} 行违规`;
    } catch (error) {
      fkMismatch = String(error?.message ?? error);
    }
    check(
      "父键合法：foreign_key_check 不报 mismatch（父列存在且唯一）",
      fkMismatch,
      (x) => x === "ok",
    );

    // 列名不带前缀（§4.1 规则第四行）
    const stepCols = db
      .prepare("PRAGMA table_info(nexus_task_steps)")
      .all()
      .map((c) => c.name);
    check(
      "列名不带前缀，用 task_id 而不是 nexus_task_id",
      [stepCols.includes("task_id"), stepCols.includes("nexus_task_id")],
      (x) => x[0] === true && x[1] === false,
    );
    check(
      "core 那层的字段叫 flow_id，不叫 task 什么",
      stepCols.includes("flow_id"),
      (x) => x === true,
    );

    // 只查一张表的列名挡不住别处回退。遍历所有业务表的 table_info，
    // 任何 /journey/i 列名都算 §4.1 失守。
    const journeyCols = [];
    for (const table of tables) {
      for (const col of db.prepare(`PRAGMA table_info(${table})`).all()) {
        if (/journey/i.test(col.name)) journeyCols.push(`${table}.${col.name}`);
      }
    }
    check("所有业务表都没有 Journey 残留列名", journeyCols, (x) => x.length === 0);

    // 索引、触发器、视图名同样可能把旧词带回来，一次扫完整个 sqlite_master。
    const journeyObjects = db
      .prepare("SELECT type, name FROM sqlite_master WHERE name LIKE '%journey%' COLLATE NOCASE")
      .all()
      .map((r) => `${r.type}:${r.name}`);
    check("索引/触发器/视图名也没有 Journey 残留", journeyObjects, (x) => x.length === 0);

    // 复合外键与级联在真实 schema 上成立
    db.prepare(
      "INSERT INTO nexus_tasks (id, owner_id, kind, title, status, goal_json, risk_ceiling," +
        " origin_session_key, revision, created_at, updated_at)" +
        " VALUES ('T7','o1','travel.flight','订东京机票','executing','{}','R1','s1',1,0,0)",
    ).run();
    const crossOwner = inTransaction(db, [
      "INSERT INTO nexus_task_steps (id, owner_id, task_id, seq, kind, status, title)" +
        " VALUES ('S1','o2','T7',1,'execute','running','x')",
    ]);
    check(
      "跨 owner 引用同一个 task 被复合外键拒绝",
      crossOwner,
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    const sameOwner = inTransaction(db, [
      "INSERT INTO nexus_task_steps (id, owner_id, task_id, seq, kind, status, title)" +
        " VALUES ('S1','o1','T7',1,'execute','running','x')",
    ]);
    check("同 owner 的 step 可以挂上去", sameOwner, (x) => x.ok);

    // ---- 12. 偏好表（§11）的 schema 不变量 ----
    // §11 的两条承诺要由 schema 兜住，不能靠调用方自觉：
    //   (a) 投影与 append-only 历史必须同事务写（和 claims/claim_events 同构）；
    //   (b) 同一 (scope,key) 下三种 origin 并存，但同 origin 只能有一条活的。
    console.log("\n[12] 偏好表（§11）的 schema 不变量");
    const prefCols =
      "(id, owner_id, scope, key, value_json, origin, task_id, asserted_by, confidence," +
      " head_revision_id, revision, created_at, updated_at)";
    const revCols =
      "(id, owner_id, preference_id, seq, op, value_json, origin, asserted_by," +
      " source_note, created_at)";
    // origin 决定 task_id / confidence 是否允许为空，见 §11 的 CHECK 约束
    const actorFor = (origin) => (origin === "observed" ? "agent" : "user");
    const insPref = (id, origin, taskId = "NULL", key = "'seat'", conf = null, actor = null) => {
      const c = conf !== null ? conf : origin === "observed" ? "0.8" : "NULL";
      return (
        `INSERT INTO preferences ${prefCols} VALUES ('${id}','o1','global',${key},'"window"',` +
        `'${origin}',${taskId},'${actor ?? actorFor(origin)}',${c},'R_${id}',1,0,0)`
      );
    };
    const insRev = (id, origin, note = null, actor = null) => {
      const n = note !== null ? note : origin === "observed" ? "'从 #T1/#T2 归纳'" : "NULL";
      return (
        `INSERT INTO preference_revisions ${revCols} VALUES ('R_${id}','o1','${id}',1,'set',` +
        `'"window"','${origin}','${actor ?? actorFor(origin)}',${n},0)`
      );
    };

    const prefAlone = inTransaction(db, [insPref("P1", "stated")]);
    check(
      "只写投影不写 revision → deferred 自引用在 COMMIT 时拒绝",
      prefAlone,
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    const prefPair = inTransaction(db, [insPref("P1", "stated"), insRev("P1", "stated")]);
    check("投影 + 首条 revision 同事务写入成立", prefPair, (x) => x.ok);

    const threeOrigins = inTransaction(db, [
      insPref("P2", "observed"),
      insRev("P2", "observed"),
      insPref("P3", "task_exception", "'T7'"),
      insRev("P3", "task_exception"),
    ]);
    check("同 (scope,key) 下 stated/observed/task_exception 可并存", threeOrigins, (x) => x.ok);

    const dupOrigin = inTransaction(db, [insPref("P4", "stated"), insRev("P4", "stated")]);
    check(
      "同 (scope,key,origin) 第二条活行被 preferences_active 拒",
      dupOrigin,
      (x) => !x.ok && /UNIQUE constraint failed/i.test(x.error),
    );

    const crossOwnerPref = inTransaction(db, [
      insPref("P5", "task_exception", "'T7'", "'meal'").replace("'o1'", "'o2'"),
      insRev("P5", "task_exception").replace("'o1'", "'o2'"),
    ]);
    check(
      "task_exception 引用别的 owner 的 task 被复合外键拒",
      crossOwnerPref,
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    db.prepare("UPDATE preferences SET deleted_at=1 WHERE id='P1'").run();
    const afterSoftDelete = inTransaction(db, [insPref("P6", "stated"), insRev("P6", "stated")]);
    check("软删除腾出槽位：同键可以再建一条 stated", afterSoftDelete, (x) => x.ok);

    // origin 不变量的负例：§11 的三条 CHECK 必须真的挡住非法组合
    const statedWithTask = inTransaction(db, [
      insPref("P7", "stated", "'T7'", "'meal'"),
      insRev("P7", "stated"),
    ]);
    check(
      "stated 带 task_id 被 CHECK 拒（否则 Task 例外会伪装成长期偏好）",
      statedWithTask,
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    const exceptionNoTask = inTransaction(db, [
      insPref("P8", "task_exception", "NULL", "'meal'"),
      insRev("P8", "task_exception"),
    ]);
    check(
      "task_exception 不带 task_id 被 CHECK 拒",
      exceptionNoTask,
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    const observedNoConf = inTransaction(db, [
      insPref("P9", "observed", "NULL", "'meal'", "NULL"),
      insRev("P9", "observed"),
    ]);
    check(
      "observed 缺 confidence 被 CHECK 拒",
      observedNoConf,
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    const statedWithConf = inTransaction(db, [
      insPref("P10", "stated", "NULL", "'meal'", "0.5"),
      insRev("P10", "stated"),
    ]);
    check(
      "非 observed 带 confidence 被 CHECK 拒",
      statedWithConf,
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    const observedNoNote = inTransaction(db, [
      insPref("P11", "observed", "NULL", "'meal'"),
      insRev("P11", "observed", "NULL"),
    ]);
    check(
      "observed 的 revision 缺 source_note 被 CHECK 拒",
      observedNoNote,
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    // ---- 13. 决策的 resolution effect（§8.13）----
    console.log("\n[13] 决策 effect_kind 与 Claim/Evidence 的来源独立性");
    const decCols =
      "(id, owner_id, task_id, decision_type, risk_tier, question, facts_snapshot," +
      " options_snapshot, unknowns_snapshot, grant_policy_snapshot, authority_hash," +
      " task_revision, status, effect_kind, effect_payload_canonical, chosen_action_id)";
    const insDec = (id, effect, payload = "NULL", action = "NULL") =>
      `INSERT INTO decisions ${decCols} VALUES ('${id}','o1','T7','confirm','R0','?',` +
      `'[]','[]','[]','{}','h',1,'pending','${effect}',${payload},${action})`;

    check(
      "set_preference 不带 effect_payload 被拒",
      inTransaction(db, [insDec("D1", "set_preference")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "授权类决策带 effect_payload 被拒",
      inTransaction(db, [insDec("D2", "issue_action_grant", "'{\"k\":1}'")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "set_preference 指定 chosen_action_id 被拒（它不该进 execution 路径）",
      inTransaction(db, [insDec("D3", "set_preference", "'{\"k\":1}'", "'A1'")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "set_preference 带 payload、不带 action 可以落库",
      inTransaction(db, [insDec("D4", "set_preference", "'{\"k\":1}'")]),
      (x) => x.ok,
    );

    // Claim 链与证据来源独立性（§9.5）
    const claimCols =
      "(id, owner_id, task_id, subject, predicate, value_json, state," +
      " verification_policy, head_event_id, created_at, updated_at)";
    const eventCols =
      "(id, owner_id, task_id, claim_id, seq, transition, source, actor," +
      " payload_canonical, prev_digest, digest, created_at)";
    const evCols =
      "(id, owner_id, task_id, kind, blob_key, content_hash, byte_size, source_ref_kind," +
      " source_ref_id, source_locator_canonical, source_version, source_identity_hash," +
      " source_run_id, source_session_key, source_group, source_group_rule_version," +
      " retention_policy, captured_at)";
    // identity 由 locator + version + content_hash 推导（§9.5.3），这里直接给成品
    // v0.12g：evidence.blob_key = '<content_hash>.<generation>' 且有外键，
    // 所以物理对象必须先存在。每条证据内容不同 → 自己一个 hash。
    const objCols =
      "(owner_id, content_hash, generation, blob_key, byte_size, state, ref_count," +
      " writer_attempt_id, writer_lease_until, writer_incarnation," +
      " reclaim_attempt_id, reclaim_lease_until," +
      " created_at, updated_at)";
    // writer_incarnation 有外键指向 process_incarnations（v0.12j）
    db.exec(
      "INSERT INTO process_incarnations (incarnation_id, process_boot_id, started_at)" +
        " VALUES ('proc-1', 'boot-A', 0)",
    );
    // writing 必须带 writer attempt + 租期；reclaiming 必须带 reclaim attempt + 租期
    const insObj = (hash, gen = 1, state = "live", refs = 1, size = 10, lease = 999) => {
      const w = state === "writing" ? `'w_${hash}.${gen}',${lease},'proc-1'` : "NULL,NULL,NULL";
      const r = state === "reclaiming" ? `'g_${hash}.${gen}',${lease}` : "NULL,NULL";
      return (
        `INSERT INTO blob_objects ${objCols} VALUES ('o1','${hash}',${gen},` +
        `'${hash}.${gen}',${size},'${state}',${refs},${w},${r},0,0)`
      );
    };
    const insEv = (id, identity, group, task = "T7", refKind = "tool_output") => {
      const scope = refKind === "tool_output" ? `'run1','sess1'` : "NULL,NULL";
      return (
        `INSERT INTO evidence ${evCols} VALUES ('${id}','o1','${task}','email',` +
        `'h_${id}.1','h_${id}',10,'${refKind}','r_${id}','loc_${identity}','v1','${identity}',` +
        `${scope},'${group}',1,'default',0)`
      );
    };
    const insEvWithObj = (id, identity, group, task = "T7", refKind = "tool_output") => [
      insObj(`h_${id}`),
      insEv(id, identity, group, task, refKind),
    ];

    const claimPair = inTransaction(db, [
      `INSERT INTO claims ${claimCols} VALUES ('C1','o1','T7','refund','state','null',` +
        `'ASSERTED','two-independent','E1',0,0)`,
      `INSERT INTO claim_events ${eventCols} VALUES ('E1','o1','T7','C1',1,'asserted',` +
        `'agent','agent','{}',NULL,'d1',0)`,
    ]);
    check("claim 与首个 event 同事务写入成立", claimPair, (x) => x.ok);

    check(
      "Agent 自述不能当证据：source_group='agent_assertion' 被 CHECK 拒",
      inTransaction(db, [insEv("V0", "id0", "agent_assertion")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    check(
      "两条不同来源的证据可以共存",
      inTransaction(db, [
        ...insEvWithObj("V1", "merchant-mail-1", "merchant:acme.com"),
        ...insEvWithObj("V2", "bank-txn-9", "bank:dbs"),
      ]),
      (x) => x.ok,
    );

    check(
      "同一原始来源第二次登记被 UNIQUE 拒（不能把一封邮件凑成两条证据）",
      inTransaction(db, insEvWithObj("V3", "merchant-mail-1", "merchant:acme.com")),
      (x) => !x.ok && /UNIQUE constraint failed/i.test(x.error),
    );

    check(
      "tool_output 引用缺 run/session 作用域被 CHECK 拒（toolCallId 无跨 run 唯一性）",
      inTransaction(db, [
        insObj("h9", 1, "writing", 0),
        `INSERT INTO evidence ${evCols} VALUES ('V9','o1','T7','email','h9.1','h9',10,` +
          `'tool_output','r9','loc9','v1','id9',NULL,NULL,'merchant:acme.com',1,'default',0)`,
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    // 链接事件 + 当前有效投影（§9.5.4）
    const linkEv = (ev, rel) =>
      `INSERT INTO claim_event_evidence (owner_id, task_id, claim_event_id, evidence_id,` +
      ` relation, relation_rule_version, relation_reason)` +
      ` VALUES ('o1','T7','E1','${ev}','${rel}',1,'verifier 判定')`;
    const linkProj = (ev, rel, eff) =>
      `INSERT INTO claim_evidence_links (owner_id, task_id, claim_id, evidence_id, relation,` +
      ` effective, head_link_event_id, updated_at) VALUES ('o1','T7','C1','${ev}','${rel}',${eff},'E1',0)`;
    const liveSupportGroups = () =>
      db
        .prepare(
          "SELECT COUNT(DISTINCT e.source_group) AS g FROM claim_evidence_links l" +
            " JOIN evidence e ON e.owner_id=l.owner_id AND e.task_id=l.task_id AND e.id=l.evidence_id" +
            " WHERE l.owner_id='o1' AND l.task_id='T7' AND l.claim_id='C1'" +
            " AND l.relation='supports' AND l.effective=1",
        )
        .get().g;

    check(
      "关联必须带方向与判定依据：缺 relation/rule_version/reason 被 NOT NULL 拒",
      inTransaction(db, [
        `INSERT INTO claim_event_evidence (owner_id, task_id, claim_event_id, evidence_id)` +
          ` VALUES ('o1','T7','E1','V1')`,
      ]),
      (x) => !x.ok && /NOT NULL constraint failed/i.test(x.error),
    );
    check(
      "unclassified 不能带 supersedes（判不出来就什么都不取代）",
      inTransaction(db, [
        `INSERT INTO claim_event_evidence (owner_id, task_id, claim_event_id, evidence_id,` +
          ` relation, relation_rule_version, relation_reason, supersedes_evidence_id)` +
          ` VALUES ('o1','T7','E1','V2','unclassified',1,'判不出',' V1')`,
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    db.exec(linkEv("V1", "supports"));
    db.exec(linkProj("V1", "supports", 1));
    db.exec(linkEv("V2", "contradicts"));
    db.exec(linkProj("V2", "contradicts", 1));
    check(
      "反证不计入支撑：一条 supports + 一条 contradicts 只有 1 个支撑来源",
      liveSupportGroups(),
      (x) => x === 1,
    );

    db.prepare("UPDATE claim_evidence_links SET relation='supports' WHERE evidence_id='V2'").run();
    check(
      "两条不同来源的有效支撑 → 计数 SQL 返回 2（可升 VERIFIED）",
      liveSupportGroups(),
      (x) => x === 2,
    );

    db.prepare("UPDATE claim_evidence_links SET effective=0 WHERE evidence_id='V2'").run();
    check(
      "投影里 effective=0 的关联不再被计数 SQL 统计（只证查询过滤，不证 detach 协议）",
      liveSupportGroups(),
      (x) => x === 1,
    );

    check(
      "同来源的第二条有效支撑不会把来源数推到 2",
      (() => {
        insEvWithObj("V3b", "merchant-mail-2", "merchant:acme.com").forEach((q) => db.exec(q));
        db.exec(linkEv("V3b", "supports"));
        db.exec(linkProj("V3b", "supports", 1));
        return liveSupportGroups();
      })(),
      (x) => x === 1,
    );

    // ---- effect 的跨表隔断与"所选 action"绑定（§8.12）：
    // CHECK 只管得住 decision 自己那一行；真正的隔断是把 effect_kind 与
    // chosen_action_id 放进唯一键之后的复合外键。
    db.exec(
      "INSERT INTO actions (id, owner_id, task_id, tool_name, capability, params_canonical," +
        " action_hash, reversible, created_at)" +
        " VALUES ('A1','o1','T7','nexus_action_commit','payment','{}','ah1',0,0)," +
        "        ('A2','o1','T7','nexus_action_commit','payment','{}','ah2',0,0)",
    );
    db.exec(insDec("D5", "issue_action_grant"));
    db.exec(
      "INSERT INTO decision_actions (owner_id, task_id, decision_id, action_id, decision_effect)" +
        " VALUES ('o1','T7','D5','A1','issue_action_grant')," +
        "        ('o1','T7','D5','A2','issue_action_grant')",
    );
    check(
      "非授权类决策挂不上候选 action（decision_actions 的复合外键）",
      inTransaction(db, [
        "INSERT INTO decision_actions (owner_id, task_id, decision_id, action_id, decision_effect)" +
          " VALUES ('o1','T7','D4','A1','issue_action_grant')",
      ]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    const grantCols =
      "(id, owner_id, task_id, from_decision_id, capability, tool_name, action_id," +
      " action_hash, task_revision, nonce, created_at, expires_at)";
    const insGrant = (id, decision, action) =>
      `INSERT INTO action_grants ${grantCols} VALUES ('${id}','o1','T7','${decision}',` +
      `'payment','nexus_action_commit','${action}','ah1',1,'n1',0,${FAR_FUTURE})`;

    check(
      "决策还没选定 action 时签不出 grant（chosen_action_id IS NULL）",
      inTransaction(db, [insGrant("G8", "D5", "A1")]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    // 用户选定 A1 并批准
    db.prepare(
      "UPDATE decisions SET chosen_action_id='A1', status='decided', resolution='approved'" +
        " WHERE id='D5'",
    ).run();
    check(
      "选定 A1 之后可以签出绑 A1 的 grant",
      inTransaction(db, [insGrant("G9", "D5", "A1")]),
      (x) => x.ok,
    );
    check(
      "grant 绑 A2 而用户选的是 A1 → 被拒（只在候选集里是不够的）",
      inTransaction(db, [insGrant("G12", "D5", "A2")]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );
    check(
      "事后把 chosen_action_id 改成 A2 被拒（否则就成了'选 A2、签 A1'）",
      inTransaction(db, ["UPDATE decisions SET chosen_action_id='A2' WHERE id='D5'"]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    // 先退休 G9，否则下面那条会先撞 action_grants_live 的部分唯一索引而不是外键，
    // 测试就证明不了"隔断"这件事（实测过：错误会是 UNIQUE 而不是 FOREIGN KEY）。
    db.prepare("UPDATE action_grants SET revoked_at=1 WHERE id='G9'").run();
    check(
      "grant 引用 set_preference 决策被复合外键拒（这才是真的隔断）",
      inTransaction(db, [insGrant("G10", "D4", "A1")]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    const sgCols =
      "(id, owner_id, task_id, from_decision_id, from_decision_effect, source_action_id," +
      " capability, task_revision, created_at, expires_at)";
    db.exec(insDec("D6", "issue_standing_grant"));
    db.exec(
      "INSERT INTO decision_actions (owner_id, task_id, decision_id, action_id, decision_effect)" +
        " VALUES ('o1','T7','D6','A1','issue_standing_grant')," +
        "        ('o1','T7','D6','A2','issue_standing_grant')",
    );
    db.prepare(
      "UPDATE decisions SET chosen_action_id='A1', status='decided', resolution='approved'" +
        " WHERE id='D6'",
    ).run();
    const insSg = (id, action) =>
      `INSERT INTO standing_grants ${sgCols} VALUES ('${id}','o1','T7','D6',` +
      `'issue_standing_grant','${action}','payment',1,0,${FAR_FUTURE})`;
    check(
      "standing grant 的样板动作等于 chosen_action_id 时可以签出",
      inTransaction(db, [insSg("S1", "A1")]),
      (x) => x.ok,
    );
    check(
      "standing grant 绑 A2 而用户选的是 A1 → 被拒",
      inTransaction(db, [insSg("S2", "A2")]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );
    check(
      "standing：事后把 chosen_action_id 改成 A2 被拒",
      inTransaction(db, ["UPDATE decisions SET chosen_action_id='A2' WHERE id='D6'"]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    // 批准必须选定 action：两种授权 effect 都要
    db.exec(insDec("D7", "issue_action_grant"));
    check(
      "批准的 action grant 决策不能没有 chosen_action_id",
      inTransaction(db, [
        "UPDATE decisions SET status='decided', resolution='approved' WHERE id='D7'",
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    db.exec(insDec("D8", "issue_standing_grant"));
    check(
      "批准的 standing 决策也不能没有 chosen_action_id",
      inTransaction(db, [
        "UPDATE decisions SET status='decided', resolution='approved' WHERE id='D8'",
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    // ---- 授权状态矩阵（§8.12）：光绑 chosen_action_id 不够，还得绑"已批准"。
    // 每一格用自己的 decision + 自己的 action，避免撞 action_grants_live 部分唯一索引，
    // 否则失败原因会变成 UNIQUE 而不是 FOREIGN KEY，矩阵就白跑了。
    const insActionRow = (id) =>
      `INSERT INTO actions (id, owner_id, task_id, tool_name, capability, params_canonical,` +
      ` action_hash, reversible, created_at)` +
      ` VALUES ('${id}','o1','T7','nexus_action_commit','payment','{}','h_${id}',0,0)`;
    const insDecFull = (id, effect, status, resolution, action) =>
      `INSERT INTO decisions ${decCols.replace("status,", "status, resolution,")}` +
      ` VALUES ('${id}','o1','T7','confirm','R0','?','[]','[]','[]','{}','h',1,` +
      `'${status}',${resolution},'${effect}',NULL,'${action}')`;
    const insCandidate = (decision, action, effect) =>
      `INSERT INTO decision_actions (owner_id, task_id, decision_id, action_id, decision_effect)` +
      ` VALUES ('o1','T7','${decision}','${action}','${effect}')`;

    const AUTH_MATRIX = [
      { label: "pending（还没批准）", status: "pending", resolution: "NULL", allowed: false },
      { label: "decided + denied", status: "decided", resolution: "'denied'", allowed: false },
      {
        label: "effect_apply_failed + approved",
        status: "effect_apply_failed",
        resolution: "'approved'",
        allowed: false,
      },
      { label: "decided + approved", status: "decided", resolution: "'approved'", allowed: true },
    ];
    for (const effect of ["issue_action_grant", "issue_standing_grant"]) {
      const isAction = effect === "issue_action_grant";
      const kind = isAction ? "action grant" : "standing grant";
      AUTH_MATRIX.forEach((row, i) => {
        const tag = `${isAction ? "AG" : "SG"}${i}`;
        const act = `AX${tag}`;
        const dec = `DX${tag}`;
        // chosen_action_id → decision_actions 的外键是 deferred，所以两行同事务写入
        const setup = inTransaction(db, [
          insActionRow(act),
          insDecFull(dec, effect, row.status, row.resolution, act),
          insCandidate(dec, act, effect),
        ]);
        check(`矩阵前置：${kind} / ${row.label} 的决策本身可以落库`, setup, (x) => x.ok);
        const attempt = isAction
          ? inTransaction(db, [
              `INSERT INTO action_grants ${grantCols} VALUES ('G_${tag}','o1','T7','${dec}',` +
                `'payment','nexus_action_commit','${act}','ah1',1,'n_${tag}',0,${FAR_FUTURE})`,
            ])
          : inTransaction(db, [
              `INSERT INTO standing_grants ${sgCols} VALUES ('S_${tag}','o1','T7','${dec}',` +
                `'${effect}','${act}','payment',1,0,${FAR_FUTURE})`,
            ]);
        check(`${kind} / ${row.label} → ${row.allowed ? "允许签发" : "拒绝签发"}`, attempt, (x) =>
          row.allowed ? x.ok : !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
        );
      });
    }

    // ---- blob_reservations（§9.4 / §9.5.1）：未提交字节的配额持有者。
    // 这里只证 schema 约束与配额**计数 SQL** 会把 reserved 算进去；
    // "A2 后 B 失败 → reservation 停在 reserved → 软配额挡住第 k 次" 的完整协议
    // 属于 Stage 3 真实入口测试。
    const resCols =
      "(id, owner_id, task_id, content_hash, generation, byte_size, state," +
      " reclaim_attempt_id, reclaim_lease_until, expires_at, created_at, updated_at)";
    // A1 在同一个同步事务里建 writing 对象 + reservation（§9.5.1）；
    // reclaiming 必须带认领者与租期（CHECK）
    const insRes = (id, size, state, exp = 100, hash = null) =>
      `INSERT INTO blob_reservations ${resCols} VALUES ('${id}','o1','T7',` +
      `'${hash ?? `ch_${id}`}',1,${size},'${state}',` +
      `${state === "reclaiming" ? `'gc_${id}',999` : "NULL,NULL"},${exp},0,0)`;
    const insResWithObj = (id, size, state, exp = 100) => [
      insObj(`ch_${id}`, 1, "writing", 0, size),
      insRes(id, size, state, exp),
    ];
    check(
      "reservation 的 state 只能取四个值（v0.12f 多了 reclaiming）",
      inTransaction(db, insResWithObj("R0", 10, "promoted")),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "reservation 的 byte_size 必须为正（否则配额可以被做成负数）",
      inTransaction(db, insResWithObj("R0", 0, "reserved")),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    insResWithObj("R1", 1000, "reserved").forEach((q) => db.exec(q));
    insResWithObj("R2", 2000, "consumed").forEach((q) => db.exec(q));
    insResWithObj("R4", 400, "reclaiming", 100).forEach((q) => db.exec(q));
    // §9.4 的公式是 reserved + reclaiming；consumed/abandoned 不算。
    // 只查 reserved 的旧写法在实现漏算 reclaiming 时不会红，所以这里连 reclaiming 一起断言。
    check(
      "配额计数 SQL 把 reserved 与 reclaiming 都算进未提交字节，排除 consumed",
      db
        .prepare(
          "SELECT COALESCE(SUM(byte_size),0) AS b FROM blob_reservations" +
            " WHERE owner_id='o1' AND state IN ('reserved','reclaiming')",
        )
        .get().b,
      (x) => x === 1400,
    );
    check(
      "漏算 reclaiming 的写法会少 400（证明上一条不是恒真）",
      db
        .prepare(
          "SELECT COALESCE(SUM(byte_size),0) AS b FROM blob_reservations" +
            " WHERE owner_id='o1' AND state='reserved'",
        )
        .get().b,
      (x) => x === 1000,
    );

    insEvWithObj("V4", "bank-txn-10", "bank:dbs").forEach((q) => db.exec(q));
    db.exec("BEGIN IMMEDIATE");
    db.exec(
      `INSERT INTO claims ${claimCols} VALUES ('C2','o1','T7','s2','p','null',` +
        `'ASSERTED','two-independent','E9',0,0)`,
    );
    db.exec(
      `INSERT INTO claim_events ${eventCols} VALUES ('E9','o1','T7','C2',9,'x','agent',` +
        `'agent','{}',NULL,'d9',0)`,
    );
    db.exec("COMMIT");
    check(
      "E9 确实存在、且挂在 C2 上（下一条断言的前提）",
      db.prepare("SELECT claim_id FROM claim_events WHERE id='E9'").get().claim_id,
      (x) => x === "C2",
    );
    check(
      "投影的 head_link_event_id 不能指向另一条 claim 的事件（跨 claim 完整性）",
      inTransaction(db, [
        `INSERT INTO claim_evidence_links (owner_id, task_id, claim_id, evidence_id, relation,` +
          ` effective, head_link_event_id, updated_at)` +
          ` VALUES ('o1','T7','C1','V4','supports',1,'E9',0)`,
      ]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    // ---- purge 回执的严格联合类型（§9.4 / §11.5）
    const prCols =
      "(id, owner_id, subject_kind, task_id, task_title_hash, preference_key_hash," +
      " ledger_head_digest, claim_event_count, evidence_count, revision_count," +
      " purged_scope, requested_by, executed_at)";
    check(
      "preference 回执带 Task 元数据被拒（最小化承诺由 CHECK 兜住）",
      inTransaction(db, [
        `INSERT INTO purge_receipts ${prCols} VALUES ('R1','o1','preference',NULL,'th',` +
          `'pk',NULL,NULL,NULL,3,'preferences','u',0)`,
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "task 回执带偏好字段被拒",
      inTransaction(db, [
        `INSERT INTO purge_receipts ${prCols} VALUES ('R2','o1','task','T7','th',` +
          `'pk','d',1,1,NULL,'all','u',0)`,
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "合法的 preference 回执（只有 key hash 与 revision count）可以落库",
      inTransaction(db, [
        `INSERT INTO purge_receipts ${prCols} VALUES ('R3','o1','preference',NULL,NULL,` +
          `'pk',NULL,NULL,NULL,3,'preferences','u',0)`,
      ]),
      (x) => x.ok,
    );

    // ---- 偏好的 actor 与 origin 必须对得上（§11.6）
    check(
      "stated + agent 被拒（模型不能自称'用户说过'）",
      inTransaction(db, [
        insPref("P12", "stated", "NULL", "'bag'", null, "agent"),
        insRev("P12", "stated"),
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "observed + user 被拒",
      inTransaction(db, [
        insPref("P13", "observed", "NULL", "'bag'", null, "user"),
        insRev("P13", "observed"),
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    // §9.4：账本对 nexus_tasks 的外键**故意不级联**，所以硬清除只能是一个显式事务；
    // 而 task_exception 偏好必须级联，否则同一个事务会被一条偏好挡死。
    check(
      "账本不级联：直接删 task 被 claim_events/evidence 挡住（§9.4 的刻意设计）",
      inTransaction(db, ["DELETE FROM nexus_tasks WHERE id='T7'"]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    // v0.12f：reservation 也不级联。先把账本清掉，此时仍有一条 reserved，
    // 删 Task 必须被外键挡住——这是 purge 协议"先结算字节再删元数据"的强制点。
    const ledgerOnly = inTransaction(db, [
      "DELETE FROM claim_evidence_links WHERE task_id='T7'",
      "DELETE FROM claim_event_evidence WHERE task_id='T7'",
      "DELETE FROM claim_events WHERE task_id='T7'",
      "DELETE FROM claims WHERE task_id='T7'",
      "DELETE FROM evidence WHERE task_id='T7'",
    ]);
    check("purge 第一步：清账本本身成立", ledgerOnly, (x) => x.ok);
    check(
      "仍有 reserved reservation 时删 task 被挡住（不级联 → 不会留下无主字节）",
      inTransaction(db, ["DELETE FROM nexus_tasks WHERE id='T7'"]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    // GC 的互斥：只有 reserved 能被认领成 reclaiming；B 的 reserved→consumed 与它互斥
    db.prepare(
      "UPDATE blob_reservations SET state='reclaiming', reclaim_attempt_id='gc1'," +
        " reclaim_lease_until=999 WHERE id='R1' AND state='reserved'",
    ).run();
    check(
      "GC 认领成功后，阶段 B 的 reserved→consumed CAS 一行都改不到",
      db
        .prepare("UPDATE blob_reservations SET state='consumed' WHERE id='R1' AND state='reserved'")
        .run().changes,
      (x) => x === 0,
    );
    check(
      "reclaiming 必须带认领者与租期（否则没法丢弃迟到的收尾写）",
      inTransaction(db, [
        "UPDATE blob_reservations SET state='reclaiming', reclaim_attempt_id=NULL," +
          " reclaim_lease_until=NULL WHERE id='R1'",
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "同一 owner 的同一 content_hash 不能有第二个在世持有者",
      inTransaction(db, [insRes("R3", 500, "reserved", 100, "ch_R1")]),
      (x) => !x.ok && /UNIQUE constraint failed/i.test(x.error),
    );
    check(
      "把在世 reservation 结算掉（abandoned/consumed）之后才腾出同 hash 的槽位",
      (() => {
        db.prepare(
          "UPDATE blob_reservations SET state='abandoned', reclaim_attempt_id=NULL," +
            " reclaim_lease_until=NULL WHERE id='R1'",
        ).run();
        return inTransaction(db, [insRes("R3", 500, "reserved", 100, "ch_R1")]);
      })(),
      (x) => x.ok,
    );

    // ---- blob_objects：generation 寻址、writer/reclaim 租期、引用所有权
    // （§9.4 / §9.5.1）。口径：这一组证的是 **schema 形状 + 同事务原子性**，
    // 真实的异步时序（A2 迟到、GC 与 B 抢同一条、purge 的 P1–P5）归 Stage 3 入口测试。
    console.log("\n[14] blob_objects：generation 寻址、租期与引用所有权");
    const setReclaiming = (key, gc) =>
      `UPDATE blob_objects SET state='reclaiming', reclaim_attempt_id='${gc}',` +
      ` reclaim_lease_until=999,` +
      // writing 来源抄入 writer 身份；live 来源（writer 已 committed）保留原值，不能被 NULL 覆盖
      ` settled_writer_attempt_id=COALESCE(writer_attempt_id, settled_writer_attempt_id),` +
      ` settled_writer_incarnation=COALESCE(writer_incarnation, settled_writer_incarnation),` +
      ` writer_attempt_id=NULL, writer_lease_until=NULL, writer_incarnation=NULL` +
      ` WHERE blob_key='${key}'`;

    check(
      "同一 content_hash 不能有第二个未删除的 generation（key 永不复用）",
      inTransaction(db, [insObj("h_V1", 2, "live", 1)]),
      (x) => !x.ok && /UNIQUE constraint failed/i.test(x.error),
    );
    check(
      "writing 必须带 writer attempt 与租期（否则没有回收路径）",
      inTransaction(db, [
        `INSERT INTO blob_objects ${objCols} VALUES ('o1','nolease',1,'nolease.1',10,` +
          `'writing',0,'w1',NULL,'proc-1',NULL,NULL,0,0)`,
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "writing 必须记下发起进程的 incarnation（否则重启后无从判断原 writer 是否还活着）",
      inTransaction(db, [
        `INSERT INTO blob_objects ${objCols} VALUES ('o1','noinc',1,'noinc.1',10,` +
          `'writing',0,'w1',999,NULL,NULL,NULL,0,0)`,
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "ref_count>0 的对象不能进 reclaiming",
      inTransaction(db, [setReclaiming("h_V1.1", "g1")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "缺失证明只能出现在 deleted 墓碑上",
      inTransaction(db, [
        "UPDATE blob_objects SET absence_verified_at=1, absence_verified_attempt_id='v1'" +
          " WHERE blob_key='h_V1.1'",
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "evidence.blob_key 必须指向存在的物理对象",
      inTransaction(db, [
        `INSERT INTO evidence ${evCols} VALUES ('VX','o1','T7','email','nosuch.1','nosuch',` +
          `10,'blob','b','loc','v1','idx',NULL,NULL,'bank:dbs',1,'default',0)`,
      ]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );
    check(
      "blob_key 存在但 content_hash 对不上也被拒（身份不能和字节脱钩）",
      inTransaction(db, [
        `INSERT INTO evidence ${evCols} VALUES ('VY','o1','T7','email','h_V1.1','WRONG',` +
          `10,'blob','b','loc','v1','idy',NULL,NULL,'bank:dbs',1,'default',0)`,
      ]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    // ---- 阶段 B 的 new_object 分支：一个事务里完成四件事
    db.exec("BEGIN IMMEDIATE");
    db.exec(insObj("newobj", 1, "writing", 0, 10));
    db.exec(insRes("RN", 10, "reserved", 100, "newobj"));
    db.exec("COMMIT");
    const admitNew = inTransaction(db, [
      "UPDATE blob_reservations SET state='consumed', reclaim_attempt_id=NULL," +
        " reclaim_lease_until=NULL WHERE id='RN' AND state='reserved'",
      "UPDATE blob_objects SET state='live', settled_writer_attempt_id=writer_attempt_id," +
        " settled_writer_incarnation=writer_incarnation, writer_settled_reason='committed'," +
        " writer_attempt_id=NULL, writer_lease_until=NULL, writer_incarnation=NULL," +
        " ref_count=ref_count+1" +
        " WHERE blob_key='newobj.1' AND state='writing' AND writer_attempt_id='w_newobj.1'",
      `INSERT INTO evidence ${evCols} VALUES ('VN','o1','T7','email','newobj.1','newobj',` +
        `10,'blob','bn','loc_n','v1','id_n',NULL,NULL,'bank:dbs',1,'default',0)`,
    ]);
    check(
      "new_object 分支：consumed + live + evidence + ref_count 同一个事务里完成",
      admitNew,
      (x) => x.ok,
    );
    check(
      "writing → live 时 writer token 与租期被清空",
      db
        .prepare(
          "SELECT state, writer_attempt_id AS w, writer_lease_until AS l, ref_count AS r" +
            " FROM blob_objects WHERE blob_key='newobj.1'",
        )
        .get(),
      (x) => x.state === "live" && x.w === null && x.l === null && x.r === 1,
    );

    // ---- stale writing 必须有回收路径（A2 超时/崩溃后）
    db.exec(insObj("stale", 1, "writing", 0, 10, 1)); // writer 租期已过（1 < now）
    const reclaimStale = inTransaction(db, [
      setReclaiming("stale.1", "g_stale"),
      "UPDATE blob_objects SET state='deleted', reclaim_attempt_id=NULL," +
        " reclaim_lease_until=NULL WHERE blob_key='stale.1'",
    ]);
    check(
      "writer 租期过期的 writing 对象可以 writing → reclaiming → deleted",
      reclaimStale,
      (x) => x.ok,
    );
    check(
      "writing → reclaiming 把 writer 身份抄进 settled_*，但理由留空（尚未确认静默）",
      db
        .prepare(
          "SELECT settled_writer_attempt_id AS a, settled_writer_incarnation AS i," +
            " writer_settled_reason AS r FROM blob_objects WHERE blob_key='stale.1'",
        )
        .get(),
      (x) => x.a === "w_stale.1" && x.i === "proc-1" && x.r === null,
    );
    check(
      "只写 absence_verified_* 而不记'哪个 writer 已静默'被 CHECK 拒",
      inTransaction(db, [
        "UPDATE blob_objects SET absence_verified_at=5, absence_verified_attempt_id='v9'" +
          " WHERE blob_key='stale.1'",
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "记下 settled writer（attempt + incarnation + 理由）之后才能签发缺失证明",
      inTransaction(db, [
        "UPDATE blob_objects SET absence_verified_at=5, absence_verified_attempt_id='v9'," +
          " settled_writer_attempt_id='w_stale.1', settled_writer_incarnation='proc-1'," +
          " writer_settled_reason='incarnation_gone' WHERE blob_key='stale.1'",
      ]),
      (x) => x.ok,
    );
    check(
      "writer_settled_reason 只能取三个值（committed|awaited|incarnation_gone）",
      inTransaction(db, [
        "UPDATE blob_objects SET writer_settled_reason='assumed' WHERE blob_key='stale.1'",
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "writing → live 把 writer 身份抄进 settled_* 并记 committed",
      db
        .prepare(
          "SELECT settled_writer_attempt_id AS a, settled_writer_incarnation AS i," +
            " writer_settled_reason AS r FROM blob_objects WHERE blob_key='newobj.1'",
        )
        .get(),
      (x) => x.a === "w_newobj.1" && x.i === "proc-1" && x.r === "committed",
    );

    check(
      "墓碑复查发现字节又回来了：只作废 absence_verified_*，并累加作废次数",
      inTransaction(db, [
        "UPDATE blob_objects SET absence_verified_at=NULL, absence_verified_attempt_id=NULL," +
          " absence_invalidated_count=absence_invalidated_count+1 WHERE blob_key='stale.1'",
      ]),
      (x) => x.ok,
    );
    check(
      "作废之后 settled writer 仍在（此刻崩溃，重启仍有依据重新签发）",
      db
        .prepare(
          "SELECT settled_writer_attempt_id AS a, settled_writer_incarnation AS i," +
            " writer_settled_reason AS r, absence_invalidated_count AS n, absence_verified_at AS v" +
            " FROM blob_objects WHERE blob_key='stale.1'",
        )
        .get(),
      (x) =>
        x.a === "w_stale.1" &&
        x.i === "proc-1" &&
        x.r === "incarnation_gone" &&
        x.n === 1 &&
        x.v === null,
    );
    check(
      "作废之后只需重新写 absence_verified_*（不用重填 writer 信息）就能重新签发",
      inTransaction(db, [
        "UPDATE blob_objects SET absence_verified_at=9, absence_verified_attempt_id='v10'" +
          " WHERE blob_key='stale.1'",
      ]),
      (x) => x.ok,
    );
    check(
      "settled_* 不能只剩一半（无缺失证明的 committed 对象）：声称静默却说不出是哪个 writer 被 CHECK 拒",
      inTransaction(db, [
        "UPDATE blob_objects SET settled_writer_attempt_id=NULL WHERE blob_key='newobj.1'",
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "writer_incarnation 必须指向存在的 incarnation（外键）",
      inTransaction(db, [
        `INSERT INTO blob_objects ${objCols} VALUES ('o1','ghost',1,'ghost.1',10,` +
          `'writing',0,'w1',999,'proc-nope',NULL,NULL,0,0)`,
      ]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );
    // incarnation 的权威记录（v0.12n）：没有"至多一个当前"的唯一索引——旧行遗留不得阻塞
    // 新的 service.start。supersede 只替换 boot id 不同的旧行；同 boot id 的同进程前任
    // 保持非 gone，但新行照常登记。
    const insInc = (id, boot) =>
      "INSERT INTO process_incarnations (incarnation_id, process_boot_id, started_at)" +
      ` VALUES ('${id}', '${boot}', 1)`;
    const supersede = (boot) =>
      "UPDATE process_incarnations SET gone_at=1, gone_basis='superseded_under_gateway_lock'" +
      ` WHERE gone_at IS NULL AND process_boot_id <> '${boot}'`;
    check(
      "同进程 reload：supersede 不动同 boot id 的前任，但新 start 照常登记（不被旧行阻塞）",
      [
        db.prepare(supersede("boot-A")).run().changes,
        inTransaction(db, [insInc("proc-1b", "boot-A")]).ok,
        db
          .prepare("SELECT gone_at AS g FROM process_incarnations WHERE incarnation_id='proc-1'")
          .get().g,
      ],
      (x) => x[0] === 0 && x[1] === true && x[2] === null,
    );
    check(
      "不同进程重启：旧行被置 gone 并插入自己，在同一事务里完成",
      inTransaction(db, [supersede("boot-B"), insInc("proc-2", "boot-B")]),
      (x) => x.ok,
    );
    check(
      "上一条之后：boot-A 的两行都被 supersede，只剩 boot-B 这一行未 gone",
      db
        .prepare("SELECT incarnation_id AS i FROM process_incarnations WHERE gone_at IS NULL")
        .all()
        .map((r) => r.i),
      (x) => x.length === 1 && x[0] === "proc-2",
    );
    // ---- 真实崩溃：写入当前 incarnation 后 SIGKILL，再用同一个库文件启动"新进程"。
    // 这是真实进程崩溃（不是模拟），证的是 SQLite 层的恢复形状：新登记必须成功，
    // 旧行被 supersede，不需要人工改库。真实 OpenClaw 的 kill -9 重启属于 Stage 0 spike 3 ⑤。
    {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-kill-"));
      const dbFile = path.join(tmpDir, "nexus.sqlite");
      const schemaFile = path.join(tmpDir, "schema.sql");
      fs.writeFileSync(schemaFile, readSchemaSource());
      const childCode =
        'import { DatabaseSync } from "node:sqlite"; import fs from "node:fs";' +
        "const db = new DatabaseSync(process.argv[1]);" +
        'db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");' +
        'db.exec(fs.readFileSync(process.argv[2], "utf8"));' +
        'db.prepare("INSERT INTO process_incarnations (incarnation_id, process_boot_id, started_at)' +
        " VALUES ('inc-crashed', 'boot-crashed', 1)\").run();" +
        'process.kill(process.pid, "SIGKILL");';
      const r = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", childCode, dbFile, schemaFile],
        { encoding: "utf8" },
      );
      const db2 = new DatabaseSync(dbFile);
      db2.exec("PRAGMA foreign_keys=ON;");
      const before = db2
        .prepare("SELECT incarnation_id AS i, gone_at AS g FROM process_incarnations")
        .all();
      db2.exec("BEGIN IMMEDIATE");
      db2.prepare(supersede("boot-new")).run();
      db2.prepare(insInc("inc-new", "boot-new")).run();
      db2.exec("COMMIT");
      const after = db2
        .prepare(
          "SELECT incarnation_id AS i, gone_at AS g, gone_basis AS b FROM process_incarnations" +
            " ORDER BY started_at, incarnation_id",
        )
        .all();
      db2.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      check(
        "崩溃进程确实是被 SIGKILL 杀死的，且遗留了未 gone 的 incarnation 行",
        [r.signal, before],
        (x) => x[0] === "SIGKILL" && x[1].length === 1 && x[1][0].g === null,
      );
      check(
        "崩溃后重启：新 service.start 登记成功，旧行被 supersede，无需人工改库",
        after,
        (x) =>
          x.length === 2 &&
          x.find((r) => r.i === "inc-crashed").b === "superseded_under_gateway_lock" &&
          x.find((r) => r.i === "inc-new").g === null,
      );
    }

    // ---- process_boot_id 的来源（§9.5.1，2026-10-09 冻结为候选 D：pid + OS 进程启动时间）。
    // 注意口径：下面只证 `<pid>:<startTime>` 这个**组合规则本身**的性质（Node 级纯函数）。
    // 真实读到的值、kill -9 前后的变化、pkg/dev 的差异，是 Stage 0 spike 3 的运行时观察，
    // 记录在 §13；生产函数 resolveProcessBootId 的单元测试在 vitest 里，不在本脚本。
    const bootIdOf = (pid, startTime) =>
      Number.isFinite(pid) && Number.isFinite(startTime) ? `${pid}:${startTime}` : null;
    const bootP1 = bootIdOf(4242, 1791544804);
    check(
      "候选 D：同一个 (pid, 启动时间) 永远得到同一个 boot id（与模块实例无关）",
      [bootIdOf(4242, 1791544804), bootP1],
      (x) => typeof x[0] === "string" && x[0] === x[1],
    );
    check(
      "候选 D：pid 被复用但启动时间不同 → 不同的 boot id（只用 pid 会在这里撞）",
      [bootP1, bootIdOf(4242, 1791545179)],
      (x) => x[0] !== x[1],
    );
    check(
      "候选 D：启动时间相同但 pid 不同 → 不同的 boot id",
      [bootP1, bootIdOf(4243, 1791544804)],
      (x) => x[0] !== x[1],
    );
    check(
      "候选 D 的局限：读不到启动时间时没有 boot id（调用方必须关闭 incarnation_gone，不得自造一个）",
      [bootIdOf(4242, null), bootIdOf(4242, Number.NaN), bootIdOf(4242, undefined)],
      (x) => x.every((v) => v === null),
    );
    check(
      "process_boot_id 必须有值",
      inTransaction(db, [
        "INSERT INTO process_incarnations (incarnation_id, started_at) VALUES ('proc-x', 1)",
      ]),
      (x) => !x.ok && /NOT NULL constraint failed/i.test(x.error),
    );
    db.exec(insInc("proc-2c", "boot-B")); // 一个"当前"行供下一条用例
    check(
      "gone_at 与 gone_basis 必须成对",
      inTransaction(db, [
        "UPDATE process_incarnations SET gone_at=2 WHERE incarnation_id='proc-2c'",
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    // ---- attach_live_object：owner 已有 live 对象，另一个 Task 首次引用它
    db.exec(
      "INSERT INTO nexus_tasks (id, owner_id, kind, title, status, goal_json, risk_ceiling," +
        " origin_session_key, revision, created_at, updated_at)" +
        " VALUES ('T8','o1','k','另一个 Task','executing','{}','R1','s2',1,0,0)",
    );
    db.exec(insObj("shared", 1, "live", 1));
    db.exec(
      `INSERT INTO evidence ${evCols} VALUES ('VS7','o1','T7','email','shared.1','shared',` +
        `10,'blob','b7','loc_s','v1','id_s7',NULL,NULL,'bank:dbs',1,'default',0)`,
    );
    const attach = inTransaction(db, [
      `INSERT INTO evidence ${evCols} VALUES ('VS8','o1','T8','email','shared.1','shared',` +
        `10,'blob','b8','loc_s','v1','id_s8',NULL,NULL,'bank:dbs',1,'default',0)`,
      "UPDATE blob_objects SET ref_count=ref_count+1 WHERE blob_key='shared.1'",
    ]);
    check(
      "attach_live_object 分支：插 evidence 与 ref_count+=1 同事务（不新建对象）",
      attach,
      (x) => x.ok,
    );
    const liveRefs = (key) =>
      db.prepare("SELECT COUNT(*) AS c FROM evidence WHERE owner_id='o1' AND blob_key = ?").get(key)
        .c;
    check(
      "此时物理对象被两个 Task 共享，ref_count 与 live 引用数一致",
      [
        liveRefs("shared.1"),
        db.prepare("SELECT ref_count AS r FROM blob_objects WHERE blob_key='shared.1'").get().r,
      ],
      (x) => x[0] === 2 && x[1] === 2,
    );

    // ---- purge 的 P3：带 claim 关联的 evidence 不能直接删，只能摘引用
    // 这一组跑在第 13 组清账本之后，所以自己建一条新的 claim 来挂关联
    db.exec("BEGIN IMMEDIATE");
    db.exec(
      `INSERT INTO claims ${claimCols} VALUES ('C3','o1','T7','s3','p','null',` +
        `'ASSERTED','two-independent','E10',0,0)`,
    );
    db.exec(
      `INSERT INTO claim_events ${eventCols} VALUES ('E10','o1','T7','C3',10,'x',` +
        `'agent','agent','{}',NULL,'d10',0)`,
    );
    db.exec("COMMIT");
    const linkVS7 = inTransaction(db, [
      `INSERT INTO claim_evidence_links (owner_id, task_id, claim_id, evidence_id, relation,` +
        ` effective, head_link_event_id, updated_at)` +
        ` VALUES ('o1','T7','C3','VS7','supports',1,'E10',0)`,
    ]);
    check("前置：给共享 evidence 建一条真实 claim 关联", linkVS7, (x) => x.ok);
    check(
      "P3 若直接 DELETE evidence，会被 claim 关联的外键挡住（所以 P3 不删行）",
      inTransaction(db, ["DELETE FROM evidence WHERE id='VS7'"]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );
    const p3 = inTransaction(db, [
      "UPDATE evidence SET blob_key=NULL, redaction_state='purged' WHERE task_id='T7'" +
        " AND blob_key='shared.1'",
      "UPDATE blob_objects SET ref_count=ref_count-1 WHERE blob_key='shared.1'",
    ]);
    check("P3 的正确形状：置 blob_key=NULL 并扣减 ref_count，同一个事务", p3, (x) => x.ok);
    check("purge 掉一侧之后，另一个 Task 仍持有引用", liveRefs("shared.1"), (x) => x === 1);
    // 故障注入：同一事务里摘引用 + 扣 ref_count，中间失败必须一起回滚，
    // 不能出现"引用摘了但 ref_count 没减"或反过来的半成品
    const before = db
      .prepare("SELECT ref_count AS r FROM blob_objects WHERE blob_key='shared.1'")
      .get().r;
    const halfway = inTransaction(db, [
      "UPDATE evidence SET blob_key=NULL WHERE id='VS8'",
      "UPDATE blob_objects SET ref_count=ref_count-1 WHERE blob_key='shared.1'",
      // 触发 ref_count >= 0 的 CHECK，模拟事务中途失败
      "UPDATE blob_objects SET ref_count=-1 WHERE blob_key='shared.1'",
    ]);
    check(
      "摘引用与扣 ref_count 同事务：中途失败一起回滚",
      [
        halfway.ok,
        db.prepare("SELECT ref_count AS r FROM blob_objects WHERE blob_key='shared.1'").get().r,
        liveRefs("shared.1"),
      ],
      (x) => x[0] === false && x[1] === before && x[2] === 1,
    );
    check(
      "仍被别的 Task 引用时，物理对象进不了 reclaiming（不会被误删）",
      inTransaction(db, [setReclaiming("shared.1", "g2")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "按 content_hash 查会把已删内容的那条算成引用 → 所以必须查 blob_key",
      db
        .prepare("SELECT COUNT(*) AS c FROM evidence WHERE owner_id='o1' AND content_hash='shared'")
        .get().c,
      (x) => x === 2,
    );

    // 另一侧也 purge → ref_count 到 0 → 才允许回收
    db.exec("UPDATE evidence SET blob_key=NULL, redaction_state='purged' WHERE id='VS8'");
    db.exec("UPDATE blob_objects SET ref_count=0 WHERE blob_key='shared.1'");
    check(
      "没人引用之后，物理对象可以进 reclaiming，再进 deleted 墓碑",
      inTransaction(db, [
        setReclaiming("shared.1", "g3"),
        "UPDATE blob_objects SET state='deleted', reclaim_attempt_id=NULL," +
          " reclaim_lease_until=NULL WHERE blob_key='shared.1'",
      ]),
      (x) => x.ok,
    );
    check(
      "旧 generation 进 deleted 之后才允许建新 generation",
      inTransaction(db, [insObj("shared", 2, "live", 0)]),
      (x) => x.ok,
    );

    // ---- purge work set（§9.4 P3）：P3 清空 blob_key 之前必须先把受影响对象抄进
    // purge_work_items，否则崩溃后枚举不出来。这里证 schema 形状与同事务原子性。
    const pwiCols =
      "(owner_id, task_id, purge_id, content_hash, generation, blob_key, source_kind," +
      " refs_released, disposition, state, absence_proof_attempt_id, created_at, updated_at)";
    // absence_verified 必须带 proof token（默认 'tok0'），其余状态不得带
    const insPwi = (task, hash, disp, state, refs = 1, source = "evidence", tok = "tok0") =>
      `INSERT INTO purge_work_items ${pwiCols} VALUES ('o1','${task}','pg1','${hash}',1,` +
      `'${hash}.1','${source}',${refs},'${disp}','${state}',` +
      `${state === "absence_verified" ? `'${tok}'` : "NULL"},0,0)`;
    // purge run owner（v0.12j）：工作项必须挂在一个持久化的 run 上
    const insRun = (task, purge = "pg1", phase = "sealed", extra = "NULL,NULL") =>
      `INSERT INTO purge_runs (owner_id, task_id, purge_id, phase, workset_item_count,` +
      ` workset_sealed_at, created_at, updated_at) VALUES ('o1','${task}','${purge}',` +
      `'${phase}',${extra},0,0)`;
    check(
      "工作项不能挂在不存在的 purge run 上（外键）",
      inTransaction(db, [insPwi("T7", "shared", "reclaim_pending", "pending")]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );
    check(
      "phase='workset_sealed' 必须同时带 item_count 与 sealed_at",
      inTransaction(db, [insRun("T7", "pgX", "workset_sealed")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "phase 只能取三个值",
      inTransaction(db, [insRun("T7", "pgX", "done")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    db.exec(insRun("T7", "pg1", "sealed"));
    check(
      "一个 Task 只能有一个 purge run（重试沿用同一个 purge_id，而不是再开一个）",
      inTransaction(db, [insRun("T7", "pg2", "sealed")]),
      (x) => !x.ok && /UNIQUE constraint failed/i.test(x.error),
    );
    check(
      "工作项的 blob_key 必须与声明的 (hash, generation) 指向同一个物理对象",
      inTransaction(db, [
        `INSERT INTO purge_work_items ${pwiCols} VALUES ('o1','T7','pg1','h_V1',1,` +
          `'h_V2.1','evidence',1,'reclaim_pending','pending',NULL,0,0)`,
      ]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );
    check(
      "工作项的 disposition 随最新引用数改写：shared_retained ↔ reclaim_pending 双向都允许",
      (() => {
        db.exec(insObj("flip", 1, "live", 1));
        db.exec(insPwi("T7", "flip", "shared_retained", "pending"));
        const a = db
          .prepare(
            "UPDATE purge_work_items SET disposition='reclaim_pending' WHERE blob_key='flip.1'" +
              " AND state='pending'",
          )
          .run().changes;
        const b = db
          .prepare(
            "UPDATE purge_work_items SET disposition='shared_retained' WHERE blob_key='flip.1'" +
              " AND state='pending'",
          )
          .run().changes;
        db.exec("DELETE FROM purge_work_items WHERE blob_key='flip.1'");
        db.exec("DELETE FROM blob_objects WHERE blob_key='flip.1'");
        return [a, b];
      })(),
      (x) => x[0] === 1 && x[1] === 1,
    );
    check(
      "工作项的终态必须与 disposition 对应：要删的只能是 absence_verified",
      inTransaction(db, [insPwi("T7", "shared", "reclaim_pending", "retained_verified")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "留下的共享对象只能是 retained_verified",
      inTransaction(db, [insPwi("T7", "shared", "shared_retained", "absence_verified")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "reservation 来源的工作项 refs_released 必须为 0；evidence 来源必须为正",
      [
        inTransaction(db, [insPwi("T7", "shared", "reclaim_pending", "pending", 1, "reservation")])
          .ok,
        inTransaction(db, [insPwi("T7", "shared", "reclaim_pending", "pending", 0, "evidence")]).ok,
      ],
      (x) => x[0] === false && x[1] === false,
    );
    check(
      "source_kind 只能取 evidence|reservation",
      inTransaction(db, [insPwi("T7", "shared", "reclaim_pending", "pending", 1, "guess")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "absence_verified 必须带 proof token；其余状态不得带",
      [
        inTransaction(db, [
          `INSERT INTO purge_work_items ${pwiCols} VALUES ('o1','T7','pg1','shared',1,` +
            `'shared.1','evidence',1,'reclaim_pending','absence_verified',NULL,0,0)`,
        ]).ok,
        inTransaction(db, [
          `INSERT INTO purge_work_items ${pwiCols} VALUES ('o1','T7','pg1','shared',1,` +
            `'shared.1','evidence',1,'reclaim_pending','pending','tok',0,0)`,
        ]).ok,
      ],
      (x) => x[0] === false && x[1] === false,
    );
    check(
      "refs_released 必须为正（没摘到引用就不该有工作项）",
      inTransaction(db, [insPwi("T7", "shared", "reclaim_pending", "pending", 0)]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    // 专门再建一条有引用的证据，证明 P3 的两件事确实在同一个事务里发生
    db.exec(insObj("pw", 1, "live", 1));
    db.exec(
      `INSERT INTO evidence ${evCols} VALUES ('VPW','o1','T7','email','pw.1','pw',` +
        `10,'blob','bpw','loc_pw','v1','id_pw',NULL,NULL,'bank:dbs',1,'default',0)`,
    );
    // P2 ①：reservation 来源的对象（A1/A2 已落地、阶段 B 没产生 evidence）进工作集
    db.exec(insObj("rsv", 1, "live", 0));
    db.exec(insPwi("T7", "rsv", "reclaim_pending", "pending", 0, "reservation"));
    const p3WithWorkSet = inTransaction(db, [
      insPwi("T7", "pw", "reclaim_pending", "pending"),
      "UPDATE evidence SET blob_key=NULL, redaction_state='purged'" +
        " WHERE id='VPW' AND blob_key='pw.1'",
      "UPDATE blob_objects SET ref_count=ref_count-1 WHERE blob_key='pw.1'",
      "UPDATE purge_runs SET phase='workset_sealed'," +
        " workset_item_count=(SELECT COUNT(*) FROM purge_work_items WHERE task_id='T7'" +
        "   AND purge_id='pg1')," +
        " workset_sealed_at=1 WHERE task_id='T7' AND purge_id='pg1' AND phase='sealed'",
    ]);
    check(
      "P3：写工作项 + 清空 blob_key + 扣 ref_count + 封 run 在同一个事务里",
      [
        p3WithWorkSet.ok,
        db.prepare("SELECT blob_key AS k FROM evidence WHERE id='VPW'").get().k,
        db.prepare("SELECT ref_count AS r FROM blob_objects WHERE blob_key='pw.1'").get().r,
      ],
      (x) => x[0] === true && x[1] === null && x[2] === 0,
    );
    check(
      "evidence 的引用已经清空，但工作项仍记着 blob_key → 崩溃重启后可枚举",
      db
        .prepare(
          "SELECT blob_key AS k, state AS s FROM purge_work_items" +
            " WHERE owner_id='o1' AND task_id='T7' AND purge_id='pg1' AND source_kind='evidence'",
        )
        .get(),
      (x) => x.k === "pw.1" && x.s === "pending",
    );
    check(
      "item_count 把 reservation 来源也算进去（2 = evidence 1 + reservation 1）",
      db.prepare("SELECT workset_item_count AS n FROM purge_runs WHERE task_id='T7'").get().n,
      (x) => x === 2,
    );

    // ---- ref_count 是投影，不是授权（§9.4）：权威事实是 evidence.blob_key。
    // CHECK 只能保证 ref_count >= 0，保证不了它等于真实引用数，所以每处删除授权
    // 都必须带"重算"。下面三条证明：漂移能被重算查出来，带重算的回收更新会拒绝漂移对象。
    const drift = (key) =>
      db
        .prepare(
          "SELECT o.ref_count AS projected," +
            " (SELECT COUNT(*) FROM evidence e WHERE e.owner_id=o.owner_id AND e.blob_key=o.blob_key)" +
            " AS actual FROM blob_objects o WHERE o.owner_id='o1' AND o.blob_key=?",
        )
        .get(key);
    db.exec(insObj("dr", 1, "live", 1));
    db.exec(
      `INSERT INTO evidence ${evCols} VALUES ('VDR','o1','T7','email','dr.1','dr',` +
        `10,'blob','bdr','loc_dr','v1','id_dr',NULL,NULL,'bank:dbs',1,'default',0)`,
    );
    check(
      "重算：正常状态下 ref_count 等于 evidence.blob_key 的真实引用数",
      drift("dr.1"),
      (x) => x.projected === 1 && x.actual === 1,
    );
    db.exec("UPDATE blob_objects SET ref_count=0 WHERE blob_key='dr.1'"); // 少算：CHECK 拦不住
    check(
      "少减/漏记：投影为 0 但仍有 evidence 引用——schema 拦不住，重算能查出",
      drift("dr.1"),
      (x) => x.projected === 0 && x.actual === 1,
    );
    const guardedReclaim = (key) =>
      db
        .prepare(
          "UPDATE blob_objects SET state='reclaiming', reclaim_attempt_id='g_dr'," +
            " reclaim_lease_until=999 WHERE owner_id='o1' AND blob_key=? AND state='live'" +
            " AND ref_count=0 AND (SELECT COUNT(*) FROM evidence e" +
            " WHERE e.owner_id=blob_objects.owner_id AND e.blob_key=blob_objects.blob_key)=0",
        )
        .run(key).changes;
    check(
      "带重算的回收更新拒绝漂移对象（0 行）；只信 ref_count 的写法会放行",
      [
        guardedReclaim("dr.1"),
        db
          .prepare(
            "UPDATE blob_objects SET state='reclaiming', reclaim_attempt_id='x'," +
              " reclaim_lease_until=999 WHERE blob_key='dr.1' AND ref_count=0",
          )
          .run().changes,
      ],
      (x) => x[0] === 0 && x[1] === 1,
    );
    db.exec("DELETE FROM evidence WHERE id='VDR'");
    db.exec("DELETE FROM blob_objects WHERE blob_key='dr.1'");

    // P5 的前置（§9.4）：run 已 sealed、工作项数 = item_count、没有非终态项、
    // 每条 absence_verified 项的 token 等于对象**当前**的缺失证明、无在世 reservation。
    // 所有条件都带 {ownerId, taskId, purgeId}（principal-first，§4 的 store 契约）。
    // 只写 NOT EXISTS(非终态) 对空集合真空成立、对过期的终态也成立——下面逐一对照。
    const p5Gate = (owner, task, purge = "pg1") =>
      db
        .prepare(
          "SELECT (r.phase='workset_sealed'" +
            " AND (SELECT COUNT(*) FROM purge_work_items w WHERE w.owner_id=r.owner_id" +
            "      AND w.task_id=r.task_id AND w.purge_id=r.purge_id)=r.workset_item_count" +
            " AND NOT EXISTS (SELECT 1 FROM purge_work_items w WHERE w.owner_id=r.owner_id" +
            "      AND w.task_id=r.task_id AND w.purge_id=r.purge_id" +
            "      AND w.state NOT IN ('absence_verified','retained_verified'))" +
            " AND NOT EXISTS (SELECT 1 FROM purge_work_items w WHERE w.owner_id=r.owner_id" +
            "      AND w.task_id=r.task_id AND w.purge_id=r.purge_id AND w.state='absence_verified'" +
            "      AND NOT EXISTS (SELECT 1 FROM blob_objects o" +
            "        WHERE o.owner_id=w.owner_id AND o.content_hash=w.content_hash" +
            "          AND o.generation=w.generation AND o.blob_key=w.blob_key" +
            "          AND o.state='deleted' AND o.absence_verified_at IS NOT NULL" +
            "          AND o.absence_verified_attempt_id=w.absence_proof_attempt_id))" +
            " AND NOT EXISTS (SELECT 1 FROM blob_reservations v WHERE v.owner_id=r.owner_id" +
            "      AND v.task_id=r.task_id AND v.state IN ('reserved','reclaiming'))) AS ok" +
            " FROM purge_runs r WHERE r.owner_id=? AND r.task_id=? AND r.purge_id=?",
        )
        .get(owner, task, purge)?.ok;
    const naive = (task) =>
      db
        .prepare(
          "SELECT NOT EXISTS (SELECT 1 FROM purge_work_items w WHERE w.task_id=?" +
            " AND w.state NOT IN ('absence_verified','retained_verified')) AS ok",
        )
        .get(task).ok;
    const gate = () => p5Gate("o1", "T7");
    // 对象走到带证明的墓碑（live 来源，writer 已 committed）
    const tombstone = (key, tok) =>
      inTransaction(db, [
        `UPDATE blob_objects SET settled_writer_attempt_id='w_${key}',` +
          ` settled_writer_incarnation='proc-1', writer_settled_reason='committed'` +
          ` WHERE blob_key='${key}'`,
        setReclaiming(key, "g_" + key),
        `UPDATE blob_objects SET state='deleted', reclaim_attempt_id=NULL,` +
          ` reclaim_lease_until=NULL, absence_verified_at=20,` +
          ` absence_verified_attempt_id='${tok}' WHERE blob_key='${key}'`,
      ]);
    check("P5 前置：工作项还是 pending → 不放行", gate(), (x) => x === 0);
    db.prepare(
      "UPDATE blob_reservations SET state='abandoned', reclaim_attempt_id=NULL," +
        " reclaim_lease_until=NULL WHERE state IN ('reserved','reclaiming')",
    ).run();
    check(
      "两个对象都进墓碑并签发证明，P4 把 token 抄进工作项 → 放行",
      [
        tombstone("pw.1", "v20").ok,
        tombstone("rsv.1", "v21").ok,
        db
          .prepare(
            "UPDATE purge_work_items SET state='absence_verified'," +
              " absence_proof_attempt_id='v20' WHERE blob_key='pw.1'",
          )
          .run().changes,
        db
          .prepare(
            "UPDATE purge_work_items SET state='absence_verified'," +
              " absence_proof_attempt_id='v21' WHERE blob_key='rsv.1'",
          )
          .run().changes,
        gate(),
      ],
      (x) => x[0] && x[1] && x[2] === 1 && x[3] === 1 && x[4] === 1,
    );
    db.exec(
      "UPDATE blob_objects SET absence_verified_at=NULL, absence_verified_attempt_id=NULL," +
        " absence_invalidated_count=absence_invalidated_count+1 WHERE blob_key='rsv.1'",
    );
    check(
      "终态工作项 → 对象证明被作废 → P5 拒绝；只看工作项状态的写法会放行",
      [gate(), naive("T7")],
      (x) => x[0] === 0 && x[1] === 1,
    );
    db.exec(
      "UPDATE blob_objects SET absence_verified_at=22, absence_verified_attempt_id='v22'" +
        " WHERE blob_key='rsv.1'",
    );
    check(
      "重签了新证明但工作项还挂着旧 token → 仍不放行（token 必须一致）",
      gate(),
      (x) => x === 0,
    );
    db.exec("UPDATE purge_work_items SET absence_proof_attempt_id='v22' WHERE blob_key='rsv.1'");
    check("P4 把新 token 抄进工作项之后 → 放行", gate(), (x) => x === 1);
    check(
      "作废事务同时把工作项退回 pending 并清 token（CHECK 要求成对）",
      inTransaction(db, [
        "UPDATE blob_objects SET absence_verified_at=NULL, absence_verified_attempt_id=NULL," +
          " absence_invalidated_count=absence_invalidated_count+1 WHERE blob_key='rsv.1'",
        "UPDATE purge_work_items SET state='pending', absence_proof_attempt_id=NULL" +
          " WHERE blob_key='rsv.1' AND state='absence_verified'",
      ]),
      (x) => x.ok,
    );
    check("退回 pending 之后不放行", gate(), (x) => x === 0);
    check(
      "只把状态退回 pending、不清 token 被 CHECK 拒（两者必须同时变）",
      inTransaction(db, ["UPDATE purge_work_items SET state='pending' WHERE blob_key='pw.1'"]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    db.exec(
      "UPDATE blob_objects SET absence_verified_at=23, absence_verified_attempt_id='v23'" +
        " WHERE blob_key='rsv.1'",
    );
    db.exec(
      "UPDATE purge_work_items SET state='absence_verified', absence_proof_attempt_id='v23'" +
        " WHERE blob_key='rsv.1'",
    );
    check("重新走完 P4 → 再次放行", gate(), (x) => x === 1);

    // ---- P4 终态更新与证明作废的两种交错（§9.4，v0.12l）。
    // 两条都是同步事务，由 SQLite 写锁串行化，所以只有两种顺序。
    const p4Finish = (key, tok) =>
      db
        .prepare(
          "UPDATE purge_work_items SET state='absence_verified', absence_proof_attempt_id=?1" +
            " WHERE owner_id='o1' AND task_id='T7' AND purge_id='pg1' AND blob_key=?2" +
            " AND state IN ('pending','failed') AND disposition='reclaim_pending'" +
            " AND EXISTS (SELECT 1 FROM blob_objects o WHERE o.owner_id=purge_work_items.owner_id" +
            "   AND o.content_hash=purge_work_items.content_hash" +
            "   AND o.generation=purge_work_items.generation AND o.blob_key=purge_work_items.blob_key" +
            "   AND o.state='deleted' AND o.absence_verified_at IS NOT NULL" +
            "   AND o.absence_verified_attempt_id=?1)",
        )
        .run(tok, key).changes;
    const invalidate = (key) =>
      inTransaction(db, [
        "UPDATE blob_objects SET absence_verified_at=NULL, absence_verified_attempt_id=NULL," +
          ` absence_invalidated_count=absence_invalidated_count+1 WHERE blob_key='${key}'`,
        "UPDATE purge_work_items SET state='pending', absence_proof_attempt_id=NULL" +
          ` WHERE task_id='T7' AND blob_key='${key}' AND state='absence_verified'`,
      ]);
    const sign = (key, tok) =>
      db.exec(
        `UPDATE blob_objects SET absence_verified_at=30, absence_verified_attempt_id='${tok}'` +
          ` WHERE blob_key='${key}'`,
      );
    const itemOf = (key) =>
      db
        .prepare(
          "SELECT state AS s, absence_proof_attempt_id AS t FROM purge_work_items" +
            ` WHERE task_id='T7' AND blob_key='${key}'`,
        )
        .get();
    // P4 的枚举：pending/failed，外加"终态但 token 已过期"的兜底
    const p4Pick = (fallback) =>
      db
        .prepare(
          "SELECT blob_key AS k FROM purge_work_items w WHERE w.owner_id='o1' AND w.task_id='T7'" +
            " AND w.purge_id='pg1' AND (w.state IN ('pending','failed')" +
            (fallback
              ? " OR (w.state='absence_verified' AND NOT EXISTS (SELECT 1 FROM blob_objects o" +
                "   WHERE o.owner_id=w.owner_id AND o.content_hash=w.content_hash" +
                "     AND o.generation=w.generation AND o.blob_key=w.blob_key AND o.state='deleted'" +
                "     AND o.absence_verified_attempt_id=w.absence_proof_attempt_id))"
              : "") +
            ")",
        )
        .all()
        .map((r) => r.k);
    // 交错 1：P4 读到 v23 之后，作废先提交 → P4 的条件更新必须命中 0 行
    const inv1 = invalidate("rsv.1"); // 此时项目是 absence_verified(v23)：被退回 pending
    check(
      "交错 1：作废先提交 → P4 拿旧 token 的条件更新命中 0 行，工作项保持 pending",
      [inv1.ok, p4Finish("rsv.1", "v23"), itemOf("rsv.1")],
      (x) => x[0] && x[1] === 0 && x[2].s === "pending" && x[2].t === null,
    );
    sign("rsv.1", "v24");
    check(
      "重签 v24 后 P4 取新 token → 命中 1 行，放行",
      [p4Finish("rsv.1", "v24"), gate()],
      (x) => x[0] === 1 && x[1] === 1,
    );
    // 交错 2：P4 的条件更新先提交 → 作废事务必须把它退回 pending
    const inv2 = invalidate("rsv.1");
    check(
      "交错 2：P4 先提交 → 作废事务把它退回 pending 并清 token，P5 不放行",
      [inv2.ok, itemOf("rsv.1"), gate()],
      (x) => x[0] && x[1].s === "pending" && x[1].t === null && x[2] === 0,
    );
    sign("rsv.1", "v25");
    check(
      "再次 P4 → 终态 → 放行（purge 不会停在 cleanup_pending）",
      [p4Finish("rsv.1", "v25"), gate()],
      (x) => x[0] === 1 && x[1] === 1,
    );
    // 对照：P4 先读 token、后无条件写终态（v0.12k 的写法）→ 作废夹在中间就卡死
    const inv3 = invalidate("rsv.1"); // 项目是终态 → 退回 pending
    sign("rsv.1", "v26");
    const naiveTok = "v26";
    invalidate("rsv.1"); // P4 读完 v26 之后又被作废：项目此刻是 pending → 0 行可退
    db.prepare(
      "UPDATE purge_work_items SET state='absence_verified'," +
        " absence_proof_attempt_id=? WHERE blob_key='rsv.1'",
    ).run(naiveTok); // 无条件写旧 token
    check(
      "对照：无条件写终态 → 过期终态，P5 拒绝，且只枚举 pending/failed 的 P4 再也捡不起来",
      [inv3.ok, gate(), p4Pick(false).includes("rsv.1")],
      (x) => x[0] && x[1] === 0 && x[2] === false,
    );
    check(
      "兜底枚举能捡起 token 已过期的终态项（不会永久卡住）",
      p4Pick(true).includes("rsv.1"),
      (x) => x === true,
    );
    // 兜底：把过期终态退回 pending 并重新取证
    db.exec(
      "UPDATE purge_work_items SET state='pending', absence_proof_attempt_id=NULL" +
        " WHERE blob_key='rsv.1'",
    );
    sign("rsv.1", "v27");
    check(
      "兜底之后重新取证 → 放行",
      [p4Finish("rsv.1", "v27"), gate()],
      (x) => x[0] === 1 && x[1] === 1,
    );
    check(
      "本 Task 仍有 reserved 的 reservation → 不放行（P2 必须先结算完）",
      (() => {
        const row = db
          .prepare(
            "SELECT id FROM blob_reservations WHERE task_id='T7' AND state='abandoned' LIMIT 1",
          )
          .get();
        if (!row) return "no-row";
        db.prepare("UPDATE blob_reservations SET state='reserved' WHERE id=?").run(row.id);
        const r = gate();
        db.prepare("UPDATE blob_reservations SET state='abandoned' WHERE id=?").run(row.id);
        return r;
      })(),
      (x) => x === 0,
    );
    check(
      "错误的 owner 不放行（principal-first：不能只按 task_id 查）",
      [p5Gate("o2", "T7"), p5Gate("o1", "T7", "pgZ")],
      (x) => !x[0] && !x[1],
    );
    check(
      "item_count 漏算 reservation 来源（=1）→ 不放行",
      (() => {
        db.exec("UPDATE purge_runs SET workset_item_count=1 WHERE task_id='T7'");
        const r = gate();
        db.exec("UPDATE purge_runs SET workset_item_count=2 WHERE task_id='T7'");
        return r;
      })(),
      (x) => x === 0,
    );
    db.exec("DELETE FROM purge_work_items WHERE owner_id='o1' AND task_id='T7'");
    check(
      "P5 前置：工作项不见了（数量 ≠ item_count）→ 不放行；只查 NOT EXISTS 的写法会放行",
      [gate(), naive("T7")],
      (x) => x[0] === 0 && x[1] === 1,
    );
    db.exec(
      "UPDATE purge_runs SET phase='sealed', workset_item_count=NULL," +
        " workset_sealed_at=NULL WHERE task_id='T7'",
    );
    check(
      "P5 前置：P1 之后 P3 之前的空集合 → 不放行（run 还没 sealed）",
      [gate(), naive("T7")],
      (x) => x[0] === 0 && x[1] === 1,
    );

    // ---- P2 ① 的幂等重入（§9.4，v0.12l）：工作集是"每个物理对象一条"，不是每条 reservation 一条
    db.exec(
      "INSERT INTO nexus_tasks (id, owner_id, kind, title, status, goal_json, risk_ceiling," +
        " origin_session_key, revision, created_at, updated_at)" +
        " VALUES ('T9','o1','k','P2a 重入','purging','{}','R1','s9',1,0,0)",
    );
    db.exec(insRun("T9", "pg9", "sealed"));
    db.exec(insObj("rs2", 1, "live", 0));
    db.exec(insObj("rs3", 1, "live", 0));
    const insR = (id, task, hash, state) =>
      `INSERT INTO blob_reservations ${resCols} VALUES ('${id}','o1','${task}','${hash}',1,10,` +
      `'${state}',${state === "reclaiming" ? "'gc_x',999" : "NULL,NULL"},100,0,0)`;
    db.exec(insR("RS_a", "T9", "rs2", "abandoned"));
    db.exec(insR("RS_b", "T9", "rs2", "abandoned")); // 同一对象的第二条历史 reservation
    db.exec(insR("RS_c", "T9", "rs2", "reclaiming")); // 认领已提交、回收前崩溃
    const p2a = () =>
      db
        .prepare(
          "INSERT INTO purge_work_items (owner_id, task_id, purge_id, content_hash, generation," +
            " blob_key, source_kind, refs_released, disposition, state, created_at, updated_at)" +
            " SELECT DISTINCT v.owner_id, v.task_id, ?2, v.content_hash, v.generation, o.blob_key," +
            "   'reservation', 0, 'reclaim_pending', 'pending', 0, 0" +
            " FROM blob_reservations v JOIN blob_objects o ON o.owner_id=v.owner_id" +
            "   AND o.content_hash=v.content_hash AND o.generation=v.generation" +
            " WHERE v.owner_id='o1' AND v.task_id=?1 AND v.state IN ('reserved','reclaiming','abandoned')" +
            "   AND EXISTS (SELECT 1 FROM purge_runs r WHERE r.owner_id=v.owner_id" +
            "     AND r.task_id=v.task_id AND r.purge_id=?2 AND r.phase='sealed')" +
            " ON CONFLICT (owner_id, task_id, purge_id, blob_key) DO NOTHING",
        )
        .run("T9", "pg9").changes;
    const nItems = () =>
      db.prepare("SELECT COUNT(*) AS c FROM purge_work_items WHERE task_id='T9'").get().c;
    check(
      "P2 ①：三条 reservation 指向同一个物理对象 → 只写一条工作项（按对象聚合）",
      [p2a(), nItems()],
      (x) => x[0] === 1 && x[1] === 1,
    );
    db.exec("UPDATE purge_work_items SET last_error='mark' WHERE task_id='T9'");
    check(
      "崩溃重入：再跑一遍 P2 ① → 不撞主键、不新增、不覆盖已有项",
      [
        p2a(),
        nItems(),
        db.prepare("SELECT last_error AS e FROM purge_work_items WHERE task_id='T9'").get().e,
      ],
      (x) => x[0] === 0 && x[1] === 1 && x[2] === "mark",
    );
    check(
      "对照：普通 INSERT（不带 ON CONFLICT）重入会撞主键",
      inTransaction(db, [
        insPwi("T9", "rs2", "reclaim_pending", "pending", 0, "reservation")
          .replace("'pg1'", "'pg9'")
          .replace("'T7'", "'T9'"),
      ]),
      (x) => !x.ok && /UNIQUE constraint failed/i.test(x.error),
    );
    db.exec(insR("RS_d", "T9", "rs3", "abandoned"));
    db.exec("UPDATE purge_runs SET phase='reservations_settled' WHERE task_id='T9'");
    check(
      "phase 已推进之后 P2 ① 是空操作（不会再往已定的工作集里加项）",
      [p2a(), nItems()],
      (x) => x[0] === 0 && x[1] === 1,
    );
    db.exec("DELETE FROM purge_work_items WHERE task_id='T9'");
    db.exec("DELETE FROM blob_reservations WHERE task_id='T9'");
    db.exec("DELETE FROM purge_runs WHERE task_id='T9'");
    db.exec("DELETE FROM nexus_tasks WHERE id='T9'");

    // P5 按外键顺序销毁账本：links → link events → claims/events → evidence
    // claims ↔ claim_events 互相引用（deferred），只能同一个事务里一起删
    const p5 = inTransaction(db, [
      "DELETE FROM claim_evidence_links WHERE task_id='T7' AND evidence_id='VS7'",
      "DELETE FROM claim_events WHERE id='E10'",
      "DELETE FROM claims WHERE id='C3'",
      "DELETE FROM evidence WHERE task_id IN ('T7','T8')" + " AND id IN ('VS7','VS8','VN','VPW')",
    ]);
    check("P5 按外键顺序（links → events/claims → evidence）在一个事务里销毁账本", p5, (x) => x.ok);
    db.exec("DELETE FROM nexus_tasks WHERE id='T8'");

    // 结算掉全部在世 reservation 之后，才允许删 Task
    db.prepare(
      "UPDATE blob_reservations SET state='abandoned', reclaim_attempt_id=NULL," +
        " reclaim_lease_until=NULL WHERE state IN ('reserved','reclaiming')",
    ).run();
    check(
      "purge run 还在时 DELETE nexus_tasks 被外键挡住（P5 必须先删 run）",
      inTransaction(db, [
        "DELETE FROM blob_reservations WHERE task_id='T7'",
        "DELETE FROM nexus_tasks WHERE id='T7'",
      ]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );
    const purge = inTransaction(db, [
      "DELETE FROM blob_reservations WHERE task_id='T7'",
      "DELETE FROM purge_runs WHERE task_id='T7'",
      "DELETE FROM nexus_tasks WHERE id='T7'",
    ]);
    check("结算并删掉 reservation 之后，删 task 成立", purge, (x) => x.ok);
    check(
      "删除 task 级联清掉 steps",
      db.prepare("SELECT COUNT(*) AS c FROM nexus_task_steps").get().c,
      (x) => x === 0,
    );
    check(
      "删除 task 级联清掉 task_exception 偏好及其 revisions",
      [
        db.prepare("SELECT COUNT(*) AS c FROM preferences WHERE task_id IS NOT NULL").get().c,
        db.prepare("SELECT COUNT(*) AS c FROM preference_revisions WHERE preference_id='P3'").get()
          .c,
      ],
      (x) => x[0] === 0 && x[1] === 0,
    );
    check(
      "owner 级偏好（task_id IS NULL）不受 task 删除影响",
      db.prepare("SELECT COUNT(*) AS c FROM preferences WHERE task_id IS NULL").get().c,
      (x) => x > 0,
    );
    db.close();
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.error("\n结论发生变化，请回头核对 DESIGN.md §8.5 / §6.3：");
  for (const f of failed) console.error(`  - ${f.name}`);
  process.exit(1);
}
