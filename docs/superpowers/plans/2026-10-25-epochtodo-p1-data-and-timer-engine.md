# EpochToDo 融合 P1：数据层与计时引擎 实现计划

> **面向 AI 代理的工作者：** 步骤使用复选框（`- [ ]`）跟踪进度。每任务走 TDD 循环（失败测试 → 实现 → 通过 → commit）。注意：本机没有 subagent-driven-development / executing-plans 子技能，直接按步骤顺序执行即可。

**目标：** 把 EpochToDo 的任务域数据层、纯逻辑核心与计时引擎移植进 dayflow-win（sql.js 之上），配 vitest 测试骨架，全部逻辑可在纯 Node 中测试。

**架构：** 新增 `src/main/todo/` 主进程模块域——纯逻辑（priority/hierarchy/commands）无任何依赖；服务层（service/gpu-service/timer-manager）经 `TodoDB` 接口操作 sql.js；新表并入 `db.ts` migrate()；所有对外事件经注入的 `broadcast` 回调外发（P2 接到 IPC）。测试用内存 sql.js + 注入假时钟，零 Electron 依赖。

**技术栈：** TypeScript strict、sql.js（现有）、vitest（新增 devDep，纯 JS）。

**规格：** `docs/superpowers/specs/2026-10-25-epochtodo-merge-design.md` + `2026-10-25-epochtodo-feature-inventory.md`（用户裁决版）+ `2026-10-25-epochtodo-semantics.md`（精确取值来源，下称"语义规格"）。执行者三份都读；取值冲突时：用户裁决 > 功能清单 > 语义规格 > 本计划。

## 全局约束

- 禁止引入需原生编译的依赖（`npmRebuild:false` 固定）；只允许 vitest 等纯 JS devDep。
- TS strict、禁 `any`；日志/报错文案中文；中文 Conventional Commits。
- 精确语义逐字对齐语义规格：记账门槛 **180 秒**、归档深度上限 **20**、副焦点 **2** 个、nag 默认 **15** 分钟、创建去重=精确标题、到期软/硬分流（type `reminder`=软）、snooze 不改 `original_duration`、每任务 timer 行唯一。
- 每任务收尾跑 `npm test` 与 `npm run typecheck`，通过后 commit。
- 本计划不动现有 `src/main/tasks.ts`（Dayflow 的"类型"段）与任何 UI 文案；术语改名是 P5 工作。
- IPC 通道命名沿用 `域:动作` 小写风格（如 `todo:create`），P2 起接线，本计划只发事件名：`timer:update`、`timer:ended`、`fetch-tasks`、`timer:training-update`（语义规格 §3.5）。

## 审查重点（Review Focus）

1. `parent_id` 成环（脏数据/导入异常）：树构建、bang 聚合、祖先累加、递归删除、完成级联都必须防环不挂死——hierarchy/priority/服务测试钉住。
2. `timers` 表出现重复 focus 行（EpochToDo 历史 bug）：`stopFocus` 必须逐行全部结算，不得只处理一行——任务 7 测试钉住。
3. 设置值非法（NaN/0/负/字符串）：nag 间隔等必须回退默认（15/5/10 分钟），绝不产生 `setInterval(0)` 疯转——任务 4 测试钉住。
4. 到期回调与手动 cancel/snooze 竞态（timeout 在队、行已被删）：到期处理以 DB 现状为准，缺行即静默返回不抛错——任务 8 测试钉住。
5. 时钟非单调（测试注入 now；真实环境系统回拨）：elapsed 为负按 0 处理，不写负时长、不写乱序 history——任务 7 测试钉住。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| 创建 `src/shared/todo-types.ts` | 域类型：`TaskType/TaskStatus/TimerKind/TaskRow/TimerRow/HistoryRow/TaskProject/GpuRow/TodoSettings/Command` 判别联合 |
| 创建 `src/main/todo/db.ts` | `TodoDB` 接口（`run/all/get`，对现有 DB 类的结构化子集） |
| 创建 `src/main/todo/settings.ts` | `getTodoSettings()/saveTodoSettings()`，`app_settings` 表 `todo-settings` 键，非法值回退默认 |
| 创建 `src/main/todo/priority.ts` | `countBangs(title)`、`computeBangPriorities(tasks)`（纯函数） |
| 创建 `src/main/todo/hierarchy.ts` | `buildTaskTree(tasks)`、`getAncestorChain(tasks,id)`（纯函数） |
| 创建 `src/main/todo/commands.ts` | `parseCommand(text)`（纯函数，Spotlight 文法） |
| 创建 `src/main/todo/service.ts` | `TaskService`（CRUD/去重/副焦点/级联归档） |
| 创建 `src/main/todo/gpu-service.ts` | `GpuService`（GPU 行 CRUD/忙闲） |
| 创建 `src/main/todo/timer-manager.ts` | `TimerManager`（focus/wait/training 状态机、到期、nag、健康检查） |
| 创建 `src/main/todo/index.ts` | 组合导出（P2 起被 ipc.ts 使用） |
| 修改 `src/main/db.ts` | migrate() 增补 `task_projects/tasks/timers/history/gpus` 五表 |
| 创建 `tests/helpers/memdb.ts` | 内存 sql.js + 建表 + 返回 `TodoDB`（供集成测试复用） |
| 创建 `tests/todo/*.test.ts` | 各任务测试 |
| 修改 `package.json` | devDep `vitest`、脚本 `"test": "vitest run"` |
| 创建 `vitest.config.ts` | include `tests/**/*.test.ts` |

---

### 任务 1：vitest 骨架 + bang 优先级（priority.ts）

**文件：**
- 修改：`package.json`、创建 `vitest.config.ts`
- 创建：`src/main/todo/priority.ts`、`tests/todo/priority.test.ts`

- [x] **步骤 1：编写失败的测试**

```ts
// tests/todo/priority.test.ts
describe('countBangs', () => {
  it('统计标题任意位置的 ! 个数', () => {
    expect(countBangs('a!b!!')).toBe(3)
    expect(countBangs('no bangs')).toBe(0)
    expect(countBangs('!!前置')).toBe(2)
  })
})
describe('computeBangPriorities', () => {
  it('subtree-max：父继承最响子级，只向上传播', () => {
    // 父(0 bang) 有子 'x!!' 与孙 'y!!!' → 父 eff=3；兄弟无子不受影响
    expect(map.get(parentId)).toBe(3)
  })
  it('父的 !! 不抬子（不向下传播）', () => { /* 子 eff 只看自己子树 */ })
  it('环上节点返回 0 且不死循环', () => { /* a.parent=b, b.parent=a */ })
})
```

- [x] **步骤 2：运行测试验证失败** — `npx vitest run tests/todo/priority.test.ts`，预期 FAIL（模块不存在）
- [x] **步骤 3：实现 `src/main/todo/priority.ts`**

签名：`countBangs(title: string): number`；`computeBangPriorities(tasks: {id:number; title:string; parent_id:number|null}[]): Map<number, number>`。算法按语义规格 §6（memo 化递归、`visiting` 集防环、环上节点返回 0）。同时 `npm i -D vitest` 并写好 `vitest.config.ts`（Node 环境、include `tests/**/*.test.ts`）、`package.json` 加 `"test": "vitest run"`。

- [x] **步骤 4：运行测试验证通过** — `npx vitest run`，预期 PASS
- [x] **步骤 5：Commit** — `git add -A && git commit -m "feat(todo): vitest 骨架 + bang 优先级聚合"`

### 任务 2：层级（hierarchy.ts）

**文件：** 创建 `src/main/todo/hierarchy.ts`、`tests/todo/hierarchy.test.ts`

- [x] **步骤 1：编写失败的测试**

```ts
describe('buildTaskTree', () => {
  it('过滤 archived，孤儿（父缺失/已归档）提升为根', () => { ... })
  it('同级排序严格为 prio 降序 → sort_order 升序 → created_at 升序', () => { ... })
  it('parent_id 成环时不死循环，环节点作根处理', () => { ... })
  it('递归赋 depth', () => { ... })
})
describe('getAncestorChain', () => {
  it('root→直系父顺序；maxDepth=5 截断；父缺失返回部分链', () => { ... })
})
```

- [x] **步骤 2：运行验证失败**
- [x] **步骤 3：实现** — `buildTaskTree(tasks: TaskRow[]): TaskNode[]`（TaskNode = TaskRow & {depth, children}；过滤 `status!=='archived'`；parent 不在集合→根；排序键见语义规格 §6）；`getAncestorChain(tasks, taskId, maxDepth=5): TaskRow[]`（visited 防环）。
- [x] **步骤 4：运行验证通过**
- [x] **步骤 5：Commit** — `feat(todo): 任务树构建与祖先链（防环）`

### 任务 3：Spotlight 命令解析（commands.ts）

**文件：** 创建 `src/main/todo/commands.ts`、`tests/todo/commands.test.ts`

- [x] **步骤 1：编写失败的测试**（每条给输入→期望判别联合，取值照抄语义规格 §4.1）

```ts
expect(parseCommand('')).toEqual({type:'EMPTY'})
expect(parseCommand('> 备注内容')).toEqual({type:'MEMO', memo:'备注内容'})
expect(parseCommand('@25m')).toEqual({type:'SUSPEND', time:1500, ...})
expect(parseCommand('@7')).toEqual({type:'SUSPEND', time:420, ...})        // 缺省单位分钟
expect(parseCommand('洗衣服@5m')).toEqual({type:'REMINDER', main:'洗衣服', time:300, ...})
expect(parseCommand('+ ratio 3:2')).toEqual({type:'REMINDER', main:'ratio 3:2', ...}) // 冒号不拆
expect(parseCommand('! finetune bert`A100 @90m $LLM!v2')).toEqual(
  {type:'TRAINING', main:'finetune bert', sub:'v2', time:5400, gpu:'A100', project:'LLM', ...})
expect(parseCommand('task : parent')).toEqual({type:'CREATE', main:'task', isSubtask:true, parentSearch:'parent', ...})
expect(parseCommand('child:')).toEqual({type:'CREATE', main:'child', isSubtask:true, parentSearch:undefined, ...})
// 另测：`#query` COMPLETE；`%x` TRAINING；@ 仅删第一个时间 token；`$ Project` 带空格
```

- [x] **步骤 2：运行验证失败**
- [x] **步骤 3：实现** `parseCommand(text: string): Command`——固定顺序：MEMO→前缀→子任务冒号→时间 `/@\s*(\d+)([smh]?)/i`（h×3600/s/其余×60）→项目 `/\$\s*([^\s!@%>]+)/`→GPU `` /`\s*([^\s!@%>$]+)/ ``（CREATE/FOCUS 升级 TRAINING）→main/sub 按首个 `!` 切→SUSPEND/REMINDER 推断。`Command` 判别联合在 `todo-types.ts`。
- [x] **步骤 4：运行验证通过**
- [x] **步骤 5：Commit** — `feat(todo): Spotlight 命令解析器`

### 任务 4：schema 迁移 + TodoDB + todo 设置

**文件：** 修改 `src/main/db.ts`；创建 `src/main/todo/db.ts`、`src/main/todo/settings.ts`、`tests/helpers/memdb.ts`、`tests/todo/schema-settings.test.ts`

- [x] **步骤 1：编写失败的测试**

```ts
describe('todo schema', () => {
  it('migrate 幂等：建表两次不报错', () => { ... })
  it('五表存在且 timers.task_id 外键 CASCADE', () => { /* PRAGMA foreign_keys */ })
})
describe('todo settings', () => {
  it('默认值：nag 15、quiet {23,8}、idle 15、stalled 5/10（全为分钟）', () => { ... })
  it('非法值回退：NaN/0/负数 → 默认，绝不返回 0 间隔', () => { ... })
  it('roundtrip 保存读取', () => { ... })
})
```

- [x] **步骤 2：运行验证失败**
- [x] **步骤 3：实现**
  - `db.ts` migrate() 追加（字段照语义规格 §1.2，**去掉 `dispatched_target`**，保留 `md_file_path/md_line_hash` 为 P4 预留）：`task_projects(id,name,color,created_at)`、`tasks(id,title,status,type,context_memo,total_duration,estimated_duration,tag,project_id,parent_id,is_next_action,is_side_focus,side_focus_at,sort_order,gpu_id,last_focused_at,created_at,is_webhook,md_file_path,md_line_hash)`、`timers(id,task_id,type,target_timestamp,original_duration,started_at)`、`history(id,task_id,title,type,start_time,end_time)`、`gpus(id,name,host_id,color,created_at,last_active_at)`。索引仅主键 + `timers.task_id` FK。
  - `todo/db.ts`：`export interface TodoDB { run(sql, params?): void; all<T>(sql, params?): T[]; get<T>(sql, params?): T | undefined }`。
  - `todo/settings.ts`：`TodoSettings`（键与默认值见测试）存 `app_settings` 的 `todo-settings` 键（JSON），`getTodoSettings(db)` 读时校验回退、`saveTodoSettings(db, patch)` 合并写。
  - `tests/helpers/memdb.ts`：`createMemDb(): TodoDB`——initSqlJs 内存库 + 执行与 db.ts 相同的建表 SQL（把 todo 域建表 SQL 提为 `TODO_SCHEMA_SQL` 常量导出，db.ts 与 memdb 共用）。
- [x] **步骤 4：运行验证通过**
- [x] **步骤 5：Commit** — `feat(todo): 域表 schema + TodoDB 接口 + 设置存取`

### 任务 5：TaskService 基础 CRUD

**文件：** 创建 `src/main/todo/service.ts`、`tests/todo/service.test.ts`

- [x] **步骤 1：编写失败的测试**

```ts
describe('TaskService', () => {
  it('createTask 同名未归档去重返回旧任务；skipDedup 跳过；training 类不去重', () => { ... })
  it('createTask 默认 queued/is_next_action=1/total_duration=0/sort_order 递增', () => { ... })
  it('getAllTasks LEFT JOIN timers 返回 started_at/target_timestamp/timer_type，重复 timer 行保留信息多者', () => { ... })
  it('updateTask 禁改 started_at/target_timestamp/timer_type/is_webhook（静默忽略）', () => { ... })
  it('appendMemo 空则直写，否则换行追加', () => { ... })
  it('deleteTask 递归删子树且防环；deleteAllTasks 清 tasks+history 不碰 timers 语义返回计数', () => { ... })
})
```

- [x] **步骤 2：运行验证失败**
- [x] **步骤 3：实现** `class TaskService { constructor(db: TodoDB) }`，方法与语义规格 §1.3 一致：`createTask(title, opts?)`、`getAllTasks()`、`getTask(id)`、`updateTask(id, updates)`、`appendMemo(id, text)`、`getSuggestions(maxMinutes?)`、`deleteTask(id)`、`deleteAllTasks()`。
- [x] **步骤 4：运行验证通过**
- [x] **步骤 5：Commit** — `feat(todo): TaskService 基础 CRUD 与去重`

### 任务 6：副焦点（side focus）

**文件：** 修改 `src/main/todo/service.ts`；测试 `tests/todo/service.test.ts` 追加

- [x] **步骤 1：编写失败的测试**

```ts
describe('side focus', () => {
  it('上限 2：统计 is_side_focus=1 且 status NOT IN (archived,active) 的；满则 false 不改动', () => { ... })
  it('archived/active 带旗任务不占额度', () => { ... })
  it('pickSideFocusPromotion 排序键：last_focused_at NULL 升序→last_focused_at 降序→side_focus_at NULL 升序→side_focus_at 升序', () => { ... })
})
```

- [x] **步骤 2：运行验证失败**
- [x] **步骤 3：实现** `setSideFocus(id, enabled): boolean`、`pickSideFocusPromotion(excludeId): number|null`（语义规格 §1.3/§2.4 排序键逐字）。
- [x] **步骤 4：运行验证通过**
- [x] **步骤 5：Commit** — `feat(todo): 副焦点槽位与晋升排序`

### 任务 7：TimerManager —— focus 秒表

**文件：** 创建 `src/main/todo/timer-manager.ts`、`tests/todo/timer-focus.test.ts`

- [x] **步骤 1：编写失败的测试**（注入 `now: () => number` 假时钟、`broadcast` 收集器）

```ts
describe('focus', () => {
  it('startFocus：结算旧 focus→排他清场（其他非 training active 回 queued）→插行→status=active→广播 timer:update', () => { ... })
  it('结算 ≥180s：total_duration 加自身并沿祖先累加、写 history、置 queued；<180s 丢弃时长但置 queued', () => { ... })
  it('ReviewFocus#2 重复 focus 行全部结算', () => { ... })
  it('ReviewFocus#5 now 回拨 elapsed<0 按 0（不记账不写 history）', () => { ... })
  it('started_at 为 null：只删 timer 行，不更新任务', () => { ... })
})
```

- [x] **步骤 2：运行验证失败**
- [x] **步骤 3：实现** `class TimerManager` 构造注入 `{db, tasks: TaskService, gpus: GpuService, getSettings: () => TodoSettings, broadcast, now, setTimeoutFn, clearTimeoutFn}`。实现 `startFocus/settleFocusTimer/stopFocus`（语义规格 §2.3 全部规则）。
- [x] **步骤 4：运行验证通过**
- [x] **步骤 5：Commit** — `feat(todo): 计时引擎 focus 秒表（180s 记账门槛）`

### 任务 8：TimerManager —— wait/training 与到期分流

**文件：** 修改 `timer-manager.ts`；测试 `tests/todo/timer-wait.test.ts`

- [x] **步骤 1：编写失败的测试**

```ts
describe('wait/training', () => {
  it('startWait 先结算同任务 focus（不丢时长）；每任务 timer 行唯一', () => { ... })
  it('cancelWait：training/reminder 整任务删除（有 GPU 先 idle）；其余回 queued；archived 不动', () => { ... })
  it('snooze 改 target_timestamp 不改 original_duration，status 不变', () => { ... })
  it('startTraining GPU 被占自动 pauseTraining 旧任务（回 queued、清 gpu_id、GPU idle）', () => { ... })
  it('stopTraining：已完成→archived+建 "Process {原标题}" 跟进；未完成→queued 清 gpu_id', () => { ... })
  it('到期：不删行不改 status；reminder 软路径无通知；其余发 Notification(silent) + timer:ended', () => { ... })
  it('ReviewFocus#4 到期时行已被删：静默返回', () => { ... })
})
```

- [x] **步骤 2：运行验证失败**
- [x] **步骤 3：实现** `startWait/cancelWait/snoozeTrainingReminder/startTraining/pauseTraining/stopTraining/handleTimerExpiration/cancelAll`（语义规格 §2.4/§2.5/§2.9；跟进任务标题逐字 `Process {原标题}`）。
- [x] **步骤 4：运行验证通过**
- [x] **步骤 5：Commit** — `feat(todo): 计时引擎 wait/training 与到期分流`

### 任务 9：completeTask 编排

**文件：** 修改 `timer-manager.ts` + `service.ts`；测试 `tests/todo/timer-complete.test.ts`

- [x] **步骤 1：编写失败的测试**

```ts
it('完成中任务：有父→startFocus(父)；无父→stopFocus', () => { ... })
it('级联归档自身+未归档后代（BFS 上限 20 层防环）并清其 timers/timeout', () => { ... })
```

- [x] **步骤 2：运行验证失败**
- [x] **步骤 3：实现** `TimerManager.completeTask(id)`（语义规格 §2.6）；`TaskService.completeSubtree(id): number[]`（归档集合，防环）。
- [x] **步骤 4：运行验证通过**
- [x] **步骤 5：Commit** — `feat(todo): 完成任务焦点移交与级联归档`

### 任务 10：nagging 与 GPU 健康检查

**文件：** 修改 `timer-manager.ts`；测试 `tests/todo/health.test.ts`

- [x] **步骤 1：编写失败的测试**

```ts
describe('checkTaskNagging', () => {
  it('overdueMinutes>0 且 % nagInterval===0 → 重放 handleTimerExpiration；0 分钟不重放', () => { ... })
  it('ReviewFocus#3 nagInterval 非法回退 15', () => { ... })
})
describe('checkGpuHealth', () => {
  it('静默时段 23→8 环绕命中则整检查跳过；23→8 之外运行', () => { ... })
  it('停滞：>5min 无更新 → 首次广播 stalled，每 10min 重放伪 timer:ended（title "⚠️ 训练停滞: {模型名}"）；恢复解除', () => { ... })
  it('GPU 空闲告警：有 queued training 且有 idle GPU → 节流 15min 发伪 timer:ended（type gpu-idle）', () => { ... })
})
it('reconcileStaleTraining：3 分钟宽限后归档无遥测 active training 并释放 GPU', () => { ... })
```

- [x] **步骤 2：运行验证失败**
- [x] **步骤 3：实现** `start()/stop()`（60s `setInterval` 两个检查）、`checkTaskNagging/checkGpuHealth/reconcileStaleTraining`（语义规格 §2.7/§2.8；停滞阈值/间隔/空闲间隔读 `TodoSettings` 分钟值）。合成事件标题逐字 `⚠️ 训练停滞: {模型名}`、`GPU 空闲 · N 个 GPU 上有 M 个训练任务排队`。
- [x] **步骤 4：运行验证通过**
- [x] **步骤 5：Commit** — `feat(todo): nagging 与 GPU 健康检查`

### 任务 11：组合导出 + 文档 + 全量回归

**文件：** 创建 `src/main/todo/index.ts`；修改 `AGENTS.md`

- [x] **步骤 1：实现 `index.ts`**：`createTodoDomain(db: TodoDB, opts)` 返回 `{tasks, gpus, timerManager, getSettings}`，一行装配（无新逻辑）。
- [x] **步骤 2：AGENTS.md 增补**：todo 域模块表、测试命令（`npm test`）、"新增 todo 逻辑必须配纯逻辑测试"约定、P1 已知边界（UI/IPC 未接线，P2 起）。
- [x] **步骤 3：全量回归**：`npm test` 全绿 + `npm run typecheck` 通过。
- [x] **步骤 4：Commit** — `feat(todo): 组合导出与文档（P1 收尾）`

---

## 执行交接

**计划已完成并保存到 `docs/superpowers/plans/2026-10-25-epochtodo-p1-data-and-timer-engine.md`。** 用户已明确指示"基于这个来实现"，故直接进入执行：采用**原生执行**（当前会话按步骤逐任务实现；本机无 executing-plans 子技能，按本计划步骤序列执行，任务间跑 typecheck + 全量测试）。后续计划（P2 webhook 协议层 → P3 窗口 → P4 mdSync/wandb → P5 界面与时间轴窄条 → P6 验收）在 P1 落地后凭真实接口滚动编写。
