# EpochToDo 融合 P2：webhook 协议层与 AI 提醒 实现计划

> **面向 AI 代理的工作者：** 步骤使用复选框跟踪，每任务 TDD 循环。本机无 executing-plans 子技能，按步骤顺序执行即可。

**目标：** 实现 62222 端口全部外部协议（`/hook` 四分支 + 桌宠桥 `/bridge/*`）、AI 提醒软/硬路由与 ai-dismiss 撤回闭环、webhook 训练状态更新——payload 与语义与 EpochToDo v1.4.3 **逐字节兼容**。

**架构：** `src/main/todo/ai-reminder.ts`（归一化/aiFeed/路由/撤回，纯逻辑 + 注入服务）+ `src/main/todo/server.ts`（node:http，无新依赖）+ `TimerManager.updateTrainingStatus`（训练解析/压制）。广播经 P1 已有的 `broadcast` 出口（P3 接窗口）。

**技术栈：** TypeScript strict、node:http、vitest（fetch 打临时端口做路由测试）。

**规格：** 语义规格 §3（AI 路由）、§2.10（训练更新）、§7（路由表）+ 功能清单第六节（用户裁决：外部 agent 消息通道，与内部 AI 各走各的）。

## 全局约束

- 协议逐字节兼容优先于实现自由：payload 形状、HTTP 状态码（200/400/404/500）、错误文案（英文串照抄源码）不可改。
- hook 绑 `0.0.0.0:62222`（源码行为）；`/hook` 路径**精确匹配 `req.url`**（带 query 即 404）；body 必须先拼 Buffer 再 UTF-8 解码。
- 其余同 P1：无原生编译依赖、TS strict、中文日志、每任务 `npm test` + `npm run typecheck` 后 commit。

## 审查重点（Review Focus）

1. 多字节 UTF-8 跨 TCP 包：逐 chunk 解码会产生乱码——测试用中文长 body 分块发送钉住整包解码。
2. `ai-dismiss` 的 source/title 缺省通配与 `🤖 {source} · {title}` 解析（首个 ' · ' 分隔）：用户自建同名任务绝不能被删——测试钉住只删 `🤖 ` 前缀任务。
3. 硬提醒创建失败回退临时卡片（不许抛错给 webhook 调用方）——测试钉住 200 响应 + 卡片仍存在。
4. 训练更新解析优先级（task_id → GPU 上 webhook 任务 → GPU 上任意 active → 精确标题 → 模糊 → 自动建）歧义：带 gpu_name 时严格校验 GPU 一致且只接管 webhook 任务——测试逐级钉住。
5. wandb 通道级压制（任一 wandb 条目 → webhook 训练更新整体短路返回 true）——测试钉住。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| 创建 `src/main/todo/ai-reminder.ts` | `normalizeAiReminder`（纯）、`AiFeed`（cap100/drain）、`AiReminderService`（软硬路由/promote/dismiss） |
| 创建 `src/main/todo/server.ts` | `createTodoServer(deps)`：node:http 62222、路由表、UTF-8 整包解码、CORS |
| 修改 `src/main/todo/timer-manager.ts` | 新增 `updateTrainingStatus(data)`（语义规格 §2.10） |
| 修改 `src/main/todo/index.ts` | 组合导出补 server/ai-reminder |
| 创建 `tests/todo/ai-reminder.test.ts`、`tests/todo/server.test.ts`、`tests/todo/training-update.test.ts` | 各任务测试 |

---

### 任务 1：AI 提醒归一化与 aiFeed（纯逻辑）

**文件：** 创建 `src/main/todo/ai-reminder.ts`（本任务先落纯部分）、`tests/todo/ai-reminder.test.ts`

- [x] **步骤 1：编写失败的测试**

```ts
describe('normalizeAiReminder', () => {
  it('source/title 必填（trim 后非空），否则抛 ai reminder requires "source" and "title"', () => { ... })
  it('status 白名单 success|failure|needs_input|review|progress，其余/缺失归 info', () => { ... })
  it('link 仅接受 string 否则丢弃；detail 非 null 即 String()', () => { ... })
  it('timestamp：>1e12 视为毫秒、≤1e12 视为秒×1000、缺失/非 number → now', () => { ... })
})
describe('AiFeed', () => {
  it('cap 100 头部裁剪；drain 只返回未 announced 的旧→新副本并置位', () => { ... })
})
```

- [x] **步骤 2：运行验证失败**
- [x] **步骤 3：实现**（语义规格 §3.1/§3.3 逐字）：`normalizeAiReminder(data: unknown, now: number): NormalizedAiReminder`；`createAiFeed(cap=100)` 返回 `{push(entry): void; drain(): NormalizedAiReminder[]}`，entry id 形如 `ai-1` 单调递增。
- [x] **步骤 4：运行验证通过**
- [x] **步骤 5：Commit** — `feat(todo): AI 提醒归一化与 aiFeed`

### 任务 2：AiReminderService（软硬路由 / promote / dismiss）

**文件：** 修改 `src/main/todo/ai-reminder.ts`、测试追加

- [x] **步骤 1：编写失败的测试**

```ts
describe('AiReminderService.handle', () => {
  it('success/needs_input/review → 落库 🤖 来源 · 标题（type=notification，memo=detail\\nlink）+ 广播 timer:ended+fetch-tasks', () => { ... })
  it('failure/progress/info → 只广播 ai:reminder 临时卡，不落库', () => { ... })
  it('审查重点#3：硬提醒创建失败回退临时卡，不抛错', () => { ... })
  it('无论软硬都进 aiFeed', () => { ... })
})
describe('promote', () => {
  it('建 type=reminder 任务 + 已过期 wait 行（target=now-1s）+ status=waiting', () => { ... })
})
describe('dismiss', () => { // 审查重点#2
  it('只删 🤖 前缀任务；解析 首个 " · " 分隔；source/title 缺省=通配；递归删子树；用户任务不受影响', () => { ... })
  it('source/title 都缺 → 抛 ai-dismiss requires "source" and/or "title"', () => { ... })
  it('广播 ai:reminder-dismissed {source,title,force,dismissed} + fetch-tasks', () => { ... })
})
```

- [x] **步骤 2：运行验证失败**
- [x] **步骤 3：实现** `class AiReminderService { constructor(deps: {db, tasks, broadcast, now}) }`：
  `handle(data): {ok:true}`（HARD_REMINDER_STATUSES = success/needs_input/review；落库标题 `🤖 ${source} · ${title}`、type notification、memo `[detail, link].filter(Boolean).join('\n')`）；
  `promote(source, title, detail?, link?)`；`dismiss(input): number`（语义规格 §3.4 全部规则）。
- [x] **步骤 4：运行验证通过**
- [x] **步骤 5：Commit** — `feat(todo): AI 提醒软硬路由与撤回闭环`

### 任务 3：updateTrainingStatus（webhook 训练更新）

**文件：** 修改 `src/main/todo/timer-manager.ts`、创建 `tests/todo/training-update.test.ts`

- [x] **步骤 1：编写失败的测试**

```ts
describe('updateTrainingStatus', () => {
  it('审查重点#5：任一 wandb 条目 → 整体短路返回 true', () => { ... })
  it('审查重点#4：解析优先级 task_id → GPU 上 webhook active → GPU 上任意 active → 精确标题 → 模糊；带 gpu_name 严格校验', () => { ... })
  it('全失败 → 自动建任务 title||model_name||"Training on {gpu}"（active+is_webhook）；三者皆无 → false', () => { ... })
  it('GPU 按 name+host_id 自动建卡(#4ade80)，先清同 GPU 其他非 webhook 绑定，last_active_at=now', () => { ... })
  it('metrics.status==="completed" → 归档+GPU idle+建 📋 Check results: {原标题} + 清条目', () => { ... })
  it('否则写 TrainingStatus（source=webhook）并广播 timer:training-update', () => { ... })
})
```

- [x] **步骤 2：运行验证失败**
- [x] **步骤 3：实现** `TimerManager.updateTrainingStatus(data: {...}): boolean`（语义规格 §2.10 逐条）。
- [x] **步骤 4：运行验证通过**
- [x] **步骤 5：Commit** — `feat(todo): webhook 训练状态更新与 wandb 压制`

### 任务 4：HTTP 服务器（路由表 + 桌宠桥）

**文件：** 创建 `src/main/todo/server.ts`、`tests/todo/server.test.ts`

- [x] **步骤 1：编写失败的测试**（`createTodoServer({...port: 0})` 起临时端口，fetch 打真 HTTP）

```ts
describe('todo server', () => {
  it('POST /hook kind:"ai" → 200 {success:true}；缺 source/title → 400 {error:"ai reminder requires ..." }', () => { ... })
  it('POST /hook kind:"ai-dismiss" → 200 {success:true, dismissed_tasks}', () => { ... })
  it('训练更新判定 heuristic → 200/404 {error:"Task not found"}；纯通知缺 title → 400 {error:"Title is required"}', () => { ... })
  it('审查重点#1：中文长 body 分块发送仍正确解析（整包 UTF-8）', () => { ... })
  it('/hook 带 query → 404（精确匹配 req.url）；其他路径 404；JSON 损坏 → 500 {error:"Invalid JSON or Server Error"}', () => { ... })
  it('GET /bridge/state → focus/sideFocus/queued(≤20,bang排序)/dueReminders(≤10)；GET /bridge/reminders → drain；POST /bridge/tasks → {created,task}，title>200 → 400', () => { ... })
  it('OPTIONS → 200 + CORS 头（Allow-Origin 字面量 http://localhost:*）', () => { ... })
})
```

- [x] **步骤 2：运行验证失败**
- [x] **步骤 3：实现** `createTodoServer(deps: {tasks, gpus, timerManager, ai, getSettings, broadcast, now, port?}): {start(): Promise<number>; stop(): Promise<void>}`——路由/状态码/错误文案照语义规格 §7 逐字；`triggerExternalNotification` 合成 `type:'notification'` 伪任务（id=`-1*Date.now()`）走 `timer:ended` 广播。
- [x] **步骤 4：运行验证通过**
- [x] **步骤 5：Commit** — `feat(todo): 62222 webhook 服务器与桌宠桥`

### 任务 5：组合导出 + 文档 + 全量回归

**文件：** 修改 `src/main/todo/index.ts`、`AGENTS.md`

- [x] **步骤 1：** `index.ts` 导出 ai-reminder/server；`createTodoDomain` 装配 `AiReminderService`。
- [x] **步骤 2：** AGENTS.md 更新任务域小节（P2 已接协议层、未接窗口）。
- [x] **步骤 3：** `npm test` 全绿 + `npm run typecheck`。
- [x] **步骤 4：Commit** — `feat(todo): P2 收尾（协议层组合导出与文档）`

---

## 执行交接

计划完成，保存于 `docs/superpowers/plans/2026-10-25-epochtodo-p2-webhook-protocol.md`。按用户"基于这个来实现"的指示，采用**原生执行**继续。P3（Spotlight/Overlay/Reminder 窗口）在 P2 落地后凭真实接口编写。
