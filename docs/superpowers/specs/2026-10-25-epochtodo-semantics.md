# EpochToDo 主进程语义规格（供 Dayflow for Windows 重实现对齐）

> 来源：`C:\Users\Zeyu\.zcode\workspace\default\EpochToDo`（electron/ 与 src/shared/ 为主），v1.4.3。
> 以下所有阈值、时长、边界均为源码实测行为，重实现须逐条对齐。文件路径均相对于该根目录。
> 本文档是《2026-10-25-epochtodo-merge-design.md》§6 功能对齐基线的附件之一（行为语义以此为准）。

---

## 1. 数据模型（electron/db/schema.ts、electron/db/index.ts、electron/db/service.ts）

### 1.1 存储与迁移

- SQLite（better-sqlite3）+ Kysely，库文件 `flowtask.db` 位于 `app.getPath('userData')`（`electron/dataDir.ts` 允许 `EPOCH_TODO_DATA_DIR` 环境变量改写 userData，必须在 db 模块加载前 import）。
- 迁移策略：`createTable ifNotExists` + 逐列 `addColumn` try/catch（"列已存在即忽略"）。无版本号。
- 历史数据迁移两条：`scheduler_assignments.start_hour → start_time` 改名；`UPDATE tasks SET type='reminder' WHERE type='ad-hoc'`（术语统一）。
- 索引：仅主键（tasks.id、timers.id、history.id、settings.key、tags.name、gpus.id、scheduler_*.id）。外键仅一处：`timers.task_id REFERENCES tasks.id ON DELETE CASCADE`。history.task_id **无**外键（故意保留已删任务的历史）。

### 1.2 表与字段

**tasks**（核心实体）
| 字段 | 类型 | 语义 |
|---|---|---|
| id | INTEGER PK autoincrement | |
| title | TEXT NOT NULL | |
| status | TEXT NOT NULL | 枚举 `active \| waiting \| queued \| archived` |
| type | TEXT default `'standard'` | 枚举 `standard \| reminder \| training \| notification`（旧值 'ad-hoc' 已迁移为 'reminder'；'reminder'=软提醒/ad-hoc） |
| context_memo | TEXT null | 多行追加 |
| total_duration | INTEGER default 0 | **秒**；专注累计，向父级逐层累加 |
| estimated_duration | INTEGER null | **分钟** |
| tag / project_id / parent_id | TEXT / INT null / INT null | |
| is_next_action | INT default 0 | 0/1；createTask 置 1 |
| is_side_focus | INT default 0 | 0/1 次要焦点（overlay 副焦点，最多 2 个） |
| side_focus_at | TEXT null | 置位时间 ISO，晋升 tie-break 用 |
| sort_order | INTEGER default 0 | createTask 用 `Date.now()`；MD 导入用 lineIndex |
| gpu_id | INT null | |
| last_focused_at | TEXT null | 最近一次进入/退出专注时间 |
| created_at | TEXT NOT NULL | ISO |
| started_at（虚拟） | — | 不是 tasks 列！getAllTasks LEFT JOIN timers 取 `timers.started_at` |
| is_webhook | INT default 0 | 0/1，webhook/wandb 自动创建标记 |
| dispatched_target | TEXT null | JSON `{processName, windowTitle, executablePath?, bundleId?, timestamp}` |
| md_file_path / md_line_hash | TEXT null | MD 双向同步绑定（hash 见 §5） |

**timers**：id、task_id(FK cascade)、type(`focus|wait|training`)、target_timestamp(ISO null)、original_duration(秒 null)、started_at(ISO null)。**每任务最多一行**（各 start* 都先 `delete from timers where task_id=?` 再插入）。

**history**：id、task_id、title（快照，防任务改名/删除）、type(`focus|wait|training`)、start_time、end_time（ISO）。

**gpus**：id、name、host_id(null；wandb 用 `wandb:{project}:{runId}`，webhook 用 payload.host_id 或 null)、color、created_at、last_active_at(ISO null；null=busy，非 null=最近空闲时刻)。

**projects**：id、name、description、color、created_at。**tags**：name(PK)、color。**settings**：key(PK)、value(JSON 字符串；读取时 JSON.parse，失败回退原串)。

**scheduler_gpus / scheduler_tasks / scheduler_assignments**（独立 GPU 排程子系统）：scheduler_tasks.status 枚举 `pending|scheduled|running|completed`；assignment.start_time 为绝对 ISO、duration_hours 为 real。创建 assignment 时做区间冲突检测（`newStart < aEnd && newEnd > aStart` → 抛 `Time slot conflict detected`）；建后 task→'scheduled'；删最后一条 assignment→task 回 'pending'；clearAll 全部回 'pending'。

### 1.3 TaskService 行为细则

- **createTask(title, tag?, type='standard', projectId?, parentId?, skipDedup=false)**：`type !== 'training' && !skipDedup` 时按**精确 title 相等**查同名非 archived 任务，命中即返回旧任务不新建（去重）。新建默认：status='queued'、is_next_action=1、sort_order=Date.now()、total_duration=0。
- **getAllTasks**：LEFT JOIN timers，按 sort_order asc 排序；重复 timer 行去重，优先保留带 started_at/target_timestamp 的行。返回含虚拟 started_at、target_timestamp、timer_type。
- **updateTask**：禁改 started_at/target_timestamp/timer_type/is_webhook。
- **setSideFocus(id, enabled)**：启用时统计 `is_side_focus=1 AND status NOT IN ('archived','active') AND id!=?`，≥2 则返回 false 不改动（archived 与 active 的带旗任务**不占额度**——它们不在 overlay 副排显示）。成功置位时写 side_focus_at=now；关闭仅清 0。
- **pickSideFocusPromotion(excludeId)** 排序键（严格）：`(last_focused_at IS NULL) ASC` → `last_focused_at DESC` → `(side_focus_at IS NULL) ASC` → `side_focus_at ASC`，取 1。即：有专注历史者优先（最近者先），无历史者按最早打旗（NULL 时间戳视为最老）。
- **appendMemo**：当前 memo 为空则直接写入，否则 `${current}\n${content}`。
- **getSuggestions(maxDurationMinutes?)**：status='queued'，可选 `estimated_duration <= max`，limit 5（无显式排序）。
- **deleteTask**：DFS 递归收集自身+全部后代（visited 防环）一次性 `id IN (...)` 删除。
- **deleteAllTasks**：清空 history + tasks（不碰 timers！由 main 侧先 `timerManager.cancelAll()` 清内存 timeout）。

### 1.4 任务状态机（A→B 触发条件总表）

| 转换 | 触发 |
|---|---|
| （新建）→ queued | createTask；MD 导入/同步创建 |
| queued/… → **active** | startFocus（置 active）；startTraining（置 active+gpu_id）；webhook/wandb 训练更新（置 active±gpu_id） |
| active → queued | startFocus 的"排他清场"（其他非 training 的 active 任务被降级并写 last_focused_at）；settleFocusTimer（无论时长是否记账）；cancelWait（非 reminder/training 且非 archived）；pauseTraining（另清 gpu_id）；stopTraining 未完成分支（另清 gpu_id）；GpuService.deleteGpu（非 webhook 的 active 任务 gpu_id=null+queued）；mdSync 修复（active 但无 focus timer 的僵尸） |
| （任意）→ **waiting** | startWait（写 timers wait 行）；promoteAiReminder（已过期 wait 行） |
| waiting → queued | cancelWait（standard 类型） |
| （任意）→ **archived** | completeTask（自身+全部未归档后代，深度上限 20 层）；stopTraining 已完成/forceComplete；webhook `metrics.status==='completed'`；wandb run 正常 finished；reconcileStaleTraining（启动 3 分钟后仍无遥测的 active training）；UI 手动 updateTask status |
| archived → queued | mdSync computeTaskRepairs（MD 里 [ ] 行匹配到 archived 任务时恢复） |
| reminder/training → **删除** | cancelWait（这两类取消即整任务删除；有 gpu_id 先置 GPU idle） |
| webhook 任务 → 删除 | deleteGpu（其上 is_webhook=1 的任务随 GPU 删）；cleanupWandbGpus；mdSync Phase2（hash 消失） |
| 完成时 focus 转移 | completeTask：任务正被 focus 且有 parent → `startFocus(parentId)`；无 parent → stopFocus |

注意：**计时到期不改 status**（见 §2.5）；软提醒停留在 waiting 由用户处置。

### 1.5 GpuService 细节

- **getAllGpus**：派生 activeTaskId（active 且 type='training' 且 gpu_id 匹配）；idle GPU 若 last_active_at 为 null → 行内回退 created_at||now 并**异步修复写库**（setTimeout 0）。
- **setGpuBusy** = last_active_at=null；**setGpuIdle** = last_active_at=now。
- **deleteGpu**：先删其上 is_webhook=1 的任务 → 非 webhook active 任务解绑（gpu_id=null,status='queued'）→ 删 GPU。
- **cleanupWandbGpus**（启动时）：删 host_id LIKE 'wandb:%' 的 GPU（递归 deleteGpu）；删有 `is_webhook=1 AND title LIKE 'Training on %'` 任务关联的 GPU；删孤儿 webhook 任务（is_webhook=1 且 title LIKE 'Training on %'）。
- **ProjectService.setGpuIdle/setGpuBusy** 是同名误置副本（更新 gpus.last_active_at），语义同上。

---

## 2. 计时引擎（electron/timer/manager.ts，1356 行）

### 2.1 总体结构与 tick 语义

- **主进程没有 tick 循环**。focus 是秒表：DB `timers.started_at` 为唯一真值；渲染端每秒本地推算 `elapsed = floor((now-start)/1000)`（Dashboard/useTimer.ts、Spotlight 同法）。`timer:update` 广播只是"状态变了"信号（**无参数**），不携带剩余时间。
- wait/training 是倒计时：内存 `waitTimers: Map<taskId, NodeJS.Timeout>`，`scheduleWaitCompletion(taskId, delayMs)` 到点调 `handleTimerExpiration(taskId)`。每任务至多一个 timeout，重复 schedule 先 clearTimeout。
- 常驻定时器：`setInterval(60000)` → `checkGpuHealth()` + `checkTaskNagging()`。构造时：`syncActiveTimers()`、`ensureGpuIdleState()`、`initWandb()`；`setTimeout(3*60*1000)` → `reconcileStaleTraining()`。
- 设置缓存 `settingsCache` TTL 5 分钟（整表刷新），`getSetting` 命中缓存不查库。

### 2.2 并发规则

- **focus 全局唯一**：`startFocus(taskId)` 先 `stopFocus()`（结算当前），再防御性地把所有 `status='active' AND id!=? AND type!='training'` 降为 queued（写 last_focused_at）。training 任务的 active 不受影响。
- **每任务一行 timer**：startFocus/startWait/startTraining 都先删该任务所有 timer 行与 timeout（跨类型互斥：focus 一个任务时会取消它的 wait/training）。
- **wait 并发**：不同任务可同时挂多个 wait（Map 按 taskId）。
- **training 并发**：按 GPU 串行、跨 GPU 并行。`startTraining(taskId, gpuId, durationSeconds)`：若该 GPU 有 active 任务 → 先 `pauseTraining(旧任务)`（旧任务回 queued、清 gpu_id、GPU idle）。
- focus 与同任务 wait 互斥由 `startWait` 保证：先结算该任务的 focus（`settleFocusTimer`）再挂倒计时。

### 2.3 Focus 秒表（startFocus / settleFocusTimer / stopFocus）

`settleFocusTimer(focus)` 是 stopFocus 与 startWait 共享的结算原语：

- `elapsedSeconds = floor((now - started_at)/1000)`（started_at 为 null → 0）。
- **≥ 180 秒（3 分钟）**：`total_duration += elapsed`（任务自身），**并沿 parent_id 链逐级累加到所有祖先**；status→'queued'；last_focused_at=now；插入 history 行（type='focus'，title 快照，start_time=started_at，end_time=now）。
- **< 180 秒**：丢弃时长（不写 total_duration、不写 history），但仍置 status='queued'、last_focused_at=now。
- 最后删除该 timers 行。边界：task 存在但 started_at 为 null 时**不做任何任务更新**（只删 timer 行）——status 可能滞留 active，重实现时可视为已知瑕疵但对齐。
- `stopFocus()`：找出**所有** type='focus' 的 timer 行（容忍重复行 bug）逐个结算，再广播 `timer:update`。

`startFocus` 步骤顺序：stopFocus → 排他清场（上文）→ 删本任务 timers+timeout → 插 focus 行（started_at=now，target/duration 为 null）→ status='active' → 广播 `timer:update`。

### 2.4 Wait 倒计时（startWait / cancelWait / snooze）

- `startWait(taskId, durationSeconds)`：先结算同任务 focus；删该任务 timers 行；插 wait 行（target_timestamp=now+duration，original_duration=durationSeconds，started_at=now）；status='waiting'；schedule `durationSeconds*1000`。
- `cancelWait(taskId)`：删该任务 wait 行；**training/reminder 类型整任务删除**（有 gpu_id 先 setGpuIdle）；其余未 archived 的置 'queued'（archived 不动）；清 timeout。
- `snoozeTrainingReminder(taskId, minutes)`：把 timers.target_timestamp 改为 now+minutes*60000（**不改 original_duration**），重挂 timeout，status 不变。适用于 training/reminder/standard。
- `cancelAll()`：只清全部内存 timeout（delete-all-tasks 时调用）。

### 2.5 到期语义（handleTimerExpiration）——必须精确对齐

到期**不删除 timer 行、不改任务 status**（倒计时行保留，任务继续停留在 waiting，供软提醒横幅/nag 复用）：

1. 从 waitTimers 移除。
2. 若任务 type='training' 且有 gpu_id → `setGpuIdle`（释放 GPU 卡）。
3. **type='reminder'（软路径）**：不发系统通知、不弹 Reminder 窗、无提示音——仅通过下述广播让 Spotlight/Dashboard 显示非阻塞横幅（`softReminders`：type='reminder' 且 status='waiting' 且 target_timestamp<=now）。
4. **其他类型**：`new Notification({title: training?'Training Complete':'Timer Finished', body: task.title, silent: true}).show()`（静音，Reminder 窗自带音效）。
5. 广播 `timer:ended`(taskId, task) 与 `timer:update`。

main.ts 收到 `timer:ended` 的分支：`endedTask.type === 'reminder'` 为软 → 不弹窗；否则（standard/training/notification/gpu-idle/停滞伪任务）→ `showReminderWindow` 并**延迟 1000ms** 向 Reminder 窗再发一次 `timer:ended`（等窗口加载）。Reminder 窗行为：Enter=完成（training 走 stopTraining、gpu-idle/notification 仅 dismiss、无 project 的 standard 先选项目）、Esc=training 负时（默认 15 分钟，UI 可选 5/30）或 dismiss、snooze 默认非 training 5 分钟。

### 2.6 完成（completeTask）

1. 若任务有 focus timer 且有 parent → `startFocus(parentId)`（焦点传给父）；有 focus 无 parent → stopFocus。
2. 收集自身+全部未 archived 后代（按层 BFS，**深度上限 20**防环）批量置 archived。
3. 删除这些任务的全部 timer 行、清其 timeout。

### 2.7 Nagging（checkTaskNagging，每 60s）

- 间隔设置 `reminder_nag_interval`，默认 **15 分钟**（NaN 或 <1 回退 15）。
- 扫 `timers WHERE type != 'focus'` 且有 target_timestamp；`diffMs = now - target` >0 时 `overdueMinutes = floor(diffMs/60000)`；当 `overdueMinutes > 0 && overdueMinutes % nagInterval === 0` → 重放 `handleTimerExpiration(task_id)`（重复提醒）。0 分钟由原始 setTimeout 负责，故跳过。
- 由于 60s 轮询，实际触发点在逾期分钟数恰为 15/30/45… 的检查时刻。

### 2.8 GPU 健康检查（checkGpuHealth，每 60s）

- **静默时段**设置 `gpu_quiet_hours` = `{start, end}`，默认 23→8；`start<=end` 时命中 `[start,end)`，否则环绕（`now>=start || now<end`）。静默期内整个检查跳过。
- 阈值设置：`webhook_stalled_threshold`（默认 5 分钟）→ STALL_MS；`webhook_stalled_interval`（默认 10 分钟，下限 60s）→ REMIND_MS；`gpu_idle_interval`（默认 15 分钟）→ IDLE_MS。
- **停滞检测**（对 trainingStatus 全体，含 wandb 来源）：任务缺失或 archived → 移除条目；`now - lastUpdated > STALL_MS` → 首次置 stalled=true、lastReminded=0、广播 `timer:training-update`；停滞中每 REMIND_MS（或首次立即）广播一次伪 `timer:ended`（id=taskId，title=`⚠️ 训练停滞: {modelName||task.title}`，type='training'，context_memo=`{source} 来源 · N 分钟无更新`）——会弹硬 Reminder 窗。恢复更新后 stalled=false、lastReminded=0 并广播。
- **GPU 空闲告警**：idleGpus = 全部 GPU 减去"有 active training 任务占用的 GPU"；无 idle GPU → 重置节流 lastIdleAlert=0 并返回；无 queued training 任务 → 返回；节流 `lastIdleAlert` 距今 < IDLE_MS 则跳过。触发伪 `timer:ended`（id=-1，type='gpu-idle'，title=`GPU 空闲 · N 个 GPU 上有 M 个训练任务排队`，context_memo 列前 3 个排队任务名+` 等 M 个`+空闲 GPU 名单）。
- **ensureGpuIdleState**（启动一次）：idle GPU 缺 last_active_at → 补 now。
- **reconcileStaleTraining**（启动 +3 分钟宽限）：type='training' 且 status='active' 且 **trainingStatus 内存无条目**（应用关闭期间结束/失败）→ archived + GPU idle + 清条目，然后广播 fetch-tasks 并立即 checkGpuHealth。

### 2.9 Training 生命周期（startTraining / pauseTraining / stopTraining）

- `startTraining(taskId, gpuId, durationSeconds)`：GPU 冲突则先 pauseTraining 旧任务；删旧 timer 行，插 type='training' 行（target=now+dur、started_at=now、original_duration=dur）；setGpuBusy(gpuId)；任务 status='active'、gpu_id=gpuId；schedule dur。
- `pauseTraining(taskId)`：GPU idle；清 timeout；删 timer 行（"剩余时间写回 estimated_duration"被注释未实现）；status='queued'、**gpu_id=null**。
- `stopTraining(taskId, forceComplete=false)`：GPU idle；`isFinished = forceComplete || (timer.target_timestamp 存在 && remaining<=0)`；删 timer 行。已完成 → 任务 archived，并**新建 follow-up 标准任务 `Process {原标题}`**（继承 project_id，走 createTask 去重）；未完成 → status='queued'、gpu_id=null。

### 2.10 webhook 训练状态（updateTrainingStatus）与 AI 路径

- **wandb 优先级压倒性**：若内存 trainingStatus 中**任一条** source==='wandb' → 直接 return true（webhook 整通道被忽略）；解析出 taskId 后若该条目 source==='wandb' 也跳过更新。
- 任务解析优先级（无 task_id 时）：① gpu_name(+host_id) 匹配 GPU 上的 active is_webhook 任务 → ② 该 GPU 上任意 active 任务 → ③ 精确 title 匹配 active is_webhook 任务 → ④ 模糊 `title LIKE %x%`（非 archived），webhook 任务优先排序；带 gpu_name 时严格校验：候选任务有 gpu_id 必须同名 GPU，无 gpu_id 则**仅接受 webhook 任务**。
- 全部失败 → 自动建任务：title || model_name || `Training on {gpu_name}`（type='training'，createTask 后置 status='active'、last_focused_at=now、is_webhook=1）；三者皆无 → return false（HTTP 404）。
- GPU 分配：按 `name + host_id`(可 null) 查，不存在则自动建（颜色 '#4ade80'）并回填 host_id；**先清该 GPU 上其他非 webhook 任务**（gpu_id=null、queued）；任务 gpu_id 不符则改绑+active；最后 `gpus.last_active_at=now`。
- 完成分支：`metrics.status === 'completed'` → 任务 archived、GPU idle、删 trainingStatus、**新建标准任务 `📋 Check results: {原标题}`**（无标题则 `📋 Check training results`）、广播并 return true。
- 否则写内存 TrainingStatus{taskId, gpuName, modelName, eta, metrics, lastUpdated=now, stalled:false, lastReminded:0, source:'webhook'} 并广播 `timer:training-update`。

**AI 路径**：`handleAiReminder` / `promoteAiReminder` / `dismissAiReminder` / `drainAiFeed` 见 §3。

---

## 3. AI 提醒路由（electron/timer/aiReminder.ts、aiFeed.ts + manager/App/useStore）

### 3.1 归一化（normalizeAiReminder）

- 必填 `source`、`title`（String().trim() 后空即抛 `ai reminder requires "source" and "title"`）。
- status 白名单 `success | failure | needs_input | review | progress`；其余/缺失 → `'info'`（注意 'info' 本身在类型里但不在白名单常量中）。
- `detail`：非 null 即 String()；`link`：**仅接受 string**，否则丢弃。
- `timestamp`：number 且 > 1e12 视为毫秒原样；≤ 1e12 视为秒 ×1000；缺失/非 number → Date.now()。

### 3.2 status → 卡片类型映射（重实现核心分叉）

| status | 路径 | 载体 |
|---|---|---|
| success / needs_input / review | **硬提醒**（HARD_REMINDER_STATUSES） | 持久任务：title=`🤖 {source} · {title}`，type='**notification**'，context_memo=`detail\nlink`（过滤空后 join）；立即广播 `timer:ended`(task.id, task) + `fetch-tasks` → main.ts 弹全屏 Reminder 窗+提示音（notification ≠ 'reminder' 故 isSoft=false）。硬提醒创建抛错则**回退**临时卡片 |
| failure / progress / info | **临时卡片**（ephemeral） | 仅广播 `ai:reminder`(AiReminder{id:randomUUID(), ...})，不落库 |

同时**无条件**（无论软硬）push 进 aiFeed（桌面宠物桥）。

### 3.3 内存存储结构

- **主进程 aiFeed**（`createAiFeed(cap=100)`）：数组，entry = NormalizedAiReminder + `id: 'ai-1','ai-2'…`（单调递增）+ `announced: false`；超 100 从头部裁剪。`drain()` 返回全部未 announced 的**副本**（旧→新）并置 announced=true——宠物重启重新拉取也不会重复收到。
- **渲染端 Zustand `aiReminders: AiReminder[]`**：`addAiReminder` 头插（新→旧）、**上限 20**（尾部 FIFO 丢弃）；`removeAiReminder(id)` 单条删；`clearAiReminders` 全清。每窗口独立一份（dashboard/spotlight/overlay 都订阅 `ai:reminder`）。

### 3.4 ai-dismiss 的匹配与 force 语义

Webhook `kind:"ai-dismiss"`（source/title 仅接受 string，force 仅 `=== true`）→ `dismissAiReminder`：

1. source 与 title **至少给一个**，否则抛 `ai-dismiss requires "source" and/or "title"`（HTTP 400）。
2. 只扫 `title LIKE '🤖 %'` 的任务（本集成自产），解析 `🤖 {source} · {title}`（第一个 `' · '` 分隔）；source/title 各自**精确相等**匹配，缺省方视为通配。匹配者 `TaskService.deleteTask`（递归删子树），计数 dismissed。**删除不看 force、不看 status**。
3. 广播 `ai:reminder-dismissed` `{source, title, force, dismissed}` + `fetch-tasks`。
4. main.ts 补充：若 `dismissed > 0` 且 Reminder 窗还开着 → `refs.reminder.hide()`（硬提醒残留弹窗过期作废）。

渲染端收到 `ai:reminder-dismissed` 的处理（App.tsx）：`payload.id` 存在 → `removeAiReminder(id)`（单卡）；否则 `payload.source` 存在 → `dismissAiReply(source, title ?? '', force===true)`：

- 匹配键 = **source 与 title 同时相等**（title 缺省按空串比较）；不匹配的卡全保留。
- 匹配的卡：`force` → 全删；非 force → **保留 status 为 needs_input / review 的**，删掉 info/progress/failure/success（"同一回复的其余信息卡是噪音，行动卡保留；force 表示用户已响应，一并清"）。

UI 侧（Spotlight 卡片按钮）："转为软提醒" = `ai-promote` IPC + `dismissAiReminder({source,title})`（source+title 整组删）；"完成/忽略" = `dismissAiReminder({id})`（单卡删）。两者都经 `ai:reminder-dismiss` IPC 广播到所有窗口。

`ai-promote`（promoteAiReminder）：建 type='**reminder**' 任务（同 🤖 标题/memo），插 **已过期** wait 行（target=now-1000ms、original_duration=0），status='waiting' → 立即出现在软提醒横幅（过期提醒），不弹窗。

### 3.5 跨窗口同步机制

- `ai:reminder`、`ai:reminder-dismissed`、`timer:update`、`timer:ended`、`timer:training-update`、`fetch-tasks` 经 broadcaster 发往 **dashboard、spotlight、overlay** 三窗（reminder 窗只特判收 `timer:ended`，延迟 1s）。
- 渲染端→主进程的 `ai:reminder-dismiss`（ipcMain.on）在主进程**原样转发**为 `ai:reminder-dismissed` 到三窗（含 payload.id/source/title，注意转发 payload 不带 force——本地点击的 force 语义由各窗口自行按 id/source 处理）。
- 卡片 UI 状态 pill：success=✓绿、failure=✕玫、needs_input=!琥、review=?紫、progress=⋯青、info/default=i 青；相对时间显示 <60s='刚刚'，否则 `{m}m/{h}h/{d}d`。

---

## 4. Spotlight 命令解析器（src/renderer/hooks/useCommandParser.ts + components/Spotlight.tsx）

### 4.1 文法（parseCommand，纯函数）

输入 `text.trim()`；空 → `{type:'EMPTY'}`。解析按固定顺序：

1. **MEMO**：`>` 开头 → `{type:'MEMO', memo: 余下trim}`（后续规则不再执行）。
2. **类型前缀**（消费首字符）：`+`→REMINDER、`%`→TRAINING、`#`→COMPLETE、`!`→FOCUS、无前缀→CREATE。`@` 开头**不消费**（留给时间表达式，靠推断得 SUSPEND）。
3. **子任务语法**（仅 FOCUS/CREATE）：第一个 `:` 把文本劈成 `main : parentSearch`；`parentSearch` 空则 undefined；`isSubtask=true`。其他类型冒号原样保留（`+ ratio 3:2` 不拆）。
4. **时间表达式**：正则 `/@\s*(\d+)([smh]?)/i` **第一个匹配**；单位 h→×3600、s→原值、缺省/其他→×60（分钟）；从文本中删除该 token。只支持整数+单字母单位（无 1h30m 组合）。
5. **项目**：`/\$\s*([^\s!@%>]+)/`，取第一个连续 token（`fix bug $EpochToDo` → 'EpochToDo'）。
6. **GPU**：`` /`\s*([^\s!@%>$]+)/ ``；取到后从文本删除；**若当前 type 是 CREATE 或 FOCUS → 升级为 TRAINING**（显式 `+ % #` 前缀不升级——`+ status update\`A100` 保持 REMINDER）。
7. **main/sub**：余文按 `!` 劈开：`parts[0]`=main、`parts[1]`=sub（sub 可 undefined）。
8. **SUSPEND 推断**：type 为 CREATE/FOCUS 且 main 空且有 time → SUSPEND（`@ 25m`、`@25m`）。
9. **REMINDER 推断**：type 为 CREATE 且 main 非空且有 time → REMINDER（`洗衣服@5m` → main='洗衣服', time=300）。

边界：`@7` → 420s（默认分钟）；`task @ 25m` 合法；时间 token 只删第一个；`child:` → isSubtask 无 parentSearch；水槽例子 `! finetune bert\`A100 @90m $LLM!v2` → TRAINING, gpu='A100', time=5400, project='LLM', main='finetune bert', sub='v2'。

### 4.2 建议列表与排序

- 候选过滤（input 非空时）：
  - **complete 模式**（input 以 `#` 开头）：非 archived 且 type 不是 reminder/training，title 小写包含 `#后查询串`。
  - **parentSearch 模式**（isSubtask && parentSearch）：type='standard' 且 title 包含搜索词。
  - 普通模式：type 不是 reminder/training，且（title 包含 main 或（给了 project 时）所属项目名包含 project 词）。
- **排序**：按 `computeBangPriorities`（subtree-max，见 §6）降序，**稳定排序**保持原序（原序=按 created_at 倒序）。input 为空时显示 `status='queued' && is_next_action===1` 前 10 条（按 created_at 倒序）。
- 键盘：↑↓ 循环高亮；Ctrl+1..9 直选；Esc 关窗；点击= startFocus。

### 4.3 Enter 执行语义（Spotlight.tsx handleKeyDown）

- **TRAINING 有 time 无 GPU** → 进入 GPU 选择模式（列表显示 busy 标记；↑↓/Ctrl+数字/Enter 选定）；选定后 createTask(type='training', project 模糊匹配 `name.includes`)，sub 写 memo `Context: {sub}`，`assignTaskToGpu(id, gpuId, ceil(time/60))`。
- **MEMO** → `addMemo(activeTask.id, memo)`（需有活动任务）。
- **SUSPEND 有 time 有 activeTask** → `startWait(activeTask.id, time)`（挂起当前）；可附 memo。
- **SUSPEND 有 time 无 activeTask** → 建名为 '提醒' 的 reminder 任务并 startWait。
- **FOCUS / CREATE / REMINDER / TRAINING** 统一路径：
  - title = main（REMINDER 缺省 '提醒'）；project 模糊匹配（`name.toLowerCase().includes`）。
  - 子任务解析：parentSearch 模式 → 父 = 高亮建议（无高亮取第 1 条），project 继承父；无 parentSearch → 父 = activeTask.parent_id || activeTask.id（**有 activeTask 时是"同级"语义**：activeTask 是子则建兄弟，是根则建子），project 继承解析出的父。
  - 目标解析（非 parentSearch 模式）：FOCUS 且有高亮 → 用高亮任务；否则 title **精确不区分大小写**匹配（有 project 时须同 project，排除 archived）；未命中 → createTask（standard/reminder/training 按类型），并 `is_next_action=1`（新建与命中都置 1）。
  - sub 存在 → memo `Context: {sub}`。
  - **FOCUS 分支**：有 time 且有 activeTask → **切换+挂起**：`startWait(旧active, time)` + `startFocus(目标)`；有 time 无 activeTask → `startWait(目标, time)`；无 time → `startFocus(目标)`。
  - CREATE：仅创建入队。
  - p.gpu 存在 → GPU 名模糊 `includes` 匹配；`assignTaskToGpu(id, gpuId, time?ceil(time/60):60)`（默认 60 分钟）；GPU 不匹配仅 warn、任务留在队列。
  - REMINDER → `startWait(id, p.time ?? 1800)`（**默认 30 分钟**）；TRAINING 有 time → `startWait(id, time)`。
- 输入清空，50ms 后 hideSpotlight。spotlight:hide 时主进程清理空白标题任务（status 非 active 且非 archived 且 title trim 空 → deleteTask）。
- 软提醒横幅（type='reminder'、waiting、target 已过）操作：重新设定（预设 +5/+20/+40 分钟或 `30m/1h/45s` 简式解析 `^(\d+)\s*([smh]?)$`）、▶ startFocus、✓=updateTask archived+cancelWait。
- 完成确认弹窗：standard 且无 project → 必须先选项目（↑↓/Ctrl+数字/Enter）再 `completeTask`；否则 Enter 直接 completeTask。

---

## 5. mdSync 纯逻辑（electron/mdSync/pure.ts + service.ts + autoSync.ts）

### 5.1 基础

- **hashContent(text)** = `md5(text.trim()).hex.slice(0,16)`（16 位 hex）；绑定键。
- **parseMdContent**：逐行匹配 `^(\s*)([-*+])\s+(.+)$`（仅 `- * +` 项目符号），再要求正文匹配 `^\[( |x|X)\]\s+(.+)$` 才算 checkbox bullet；纯 `- text` 忽略。depth：tab=1 级、空格=0.5 级，`Math.floor`（3 空格=1 级，4 空格=2 级）；CRLF 兼容；lineIndex 从 0 计。`checked` = `x/X`。
- **buildBulletTree**：栈式——弹出所有 `depth >= 当前` 的栈顶；栈空为根，否则挂栈顶 children。
- **generateMdFromTasks**：过滤（type 为 'standard' 或 undefined、非 archived、title 非空白）；childrenMap 按 parent_id 分组、组内 sort_order 升序；渲染 `- [ ] title`（archived 本会被渲染成 `[x]`，但已被过滤，实为死代码）、2 空格缩进、末尾换行。可选 rootParentId 子树导出。

### 5.2 computeTaskRepairs（MD→DB 单任务修复，纯函数）

对未勾选 bullet 匹配到的任务：title 不同 → 更新 title 并记 conflict{taskId, oldTitle, newTitle}（**MD 侧获胜**）；status='archived' → 'queued'（只此方向）；status='active' 且无 focus timer → 'queued'（修僵尸）；is_next_action≠1 → 1；parent_id 与推断父不同 → 改 parent_id。

### 5.3 planMdMerge（DB→MD 合并规划，纯函数）

输入 content（null=文件不存在）、tasks、filePath：

- 过滤同 generateMdFromTasks，但**含 archived**（用于把已在文件里的行改成 [x]）。
- **文件不存在**：全量生成（仅非 archived），所有任务进 rebind（绑定缺失/路径不符时），bulletCount 用 `^\s*[-*+]\s` 全量计数。
- **文件存在**：
  1. 按 hash 建 taskByHash（同 hash 后写覆盖——hash 冲突时后者赢）。
  2. 逐 bullet：hash 命中任务 → 就地重写该行（**保留原缩进与符号**），check 状态 = 任务是否 archived（`[x] `/`[ ] `），正文 = 当前 title；绑定不符进 rebind。
  3. 未入 MD 的 active 任务分两类：**orphan children**（parent 已在 MD）→ 按父分组、组内 sort_order 排序，插到**父子弹群末尾**（沿"下一行 depth>父 depth"扫描，含非 bullet 行参与推进），childIndent='  '×(父depth+1)；多组插入按位置**从后往前** splice 保索引。**truly new**（无父或父也是新的）→ 树形渲染追加到**最后一个非空行之后**（保留尾部空行）。
  4. 所有 activeNotInMd 且绑定缺失 → rebind（hash=hashContent(title)）。
  5. bulletCount = 原 bullets + orphanChildren + newLines。diagnostics={matched, orphanChildren, newRoot}。
- 已知行为（测试明示）：DB 侧改名且不动 MD → merge 会**新增一行新标题、保留旧行**；只有走 updateTaskInMd 就地改写才不重复。

### 5.4 planSubtreeMove（层级变更的手术式搬移，纯函数）

- 只处理单任务子树：bulletFor(task) = `byHash.get(task.md_line_hash) ?? byHash.get(hashContent(title))`。
- 子树跨度 = bullet 行 + 之后所有"更深 bullet 或非 bullet 行（注记）"；同深/更浅 bullet 结束跨度；**尾部空行剔除出跨度**。
- 目标深度 = 新父 bullet.depth+1（无父=0）。插入锚点：有父 → 父子弹群末尾（跳过自身跨度）；无父 → 按 sort_order 找前一个根兄弟的子群末尾，否则下一个根兄弟之前，否则文件末（`lines.length-2`）；父即自身/不可解 → 原地不动。
- `insertAfter===myEnd && delta===0` → `{moved:false}`。否则抽出跨度、校正插入索引（`insertAfter > myEnd` 时 `insertAt -= span.length`）、整段按 `rel = max(0, floor(d)-旧depth)` 重缩进为 `'  '×(targetDepth+rel)`（注记保持相对深度）、splice 回。
- 目的：防止 watcher 的 MD→DB merge 用旧缩进把 parent_id 修回去。

### 5.5 service.ts I/O 层

- 固定文件名 `epochtodo.md`（`getEpochtodoPath(folder)`）。
- **importFromMd(filePath, force, rootParentId=null)**：查重（standard 任务精确 title 集合）；有重复且 !force → 返回 `{created:0, updated:0, duplicates}` 不写库。checked bullet **跳过但其子节点上提挂到同一 parent**。新建任务：status='queued'、type='standard'、sort_order=lineIndex、is_next_action=1、写 md_file_path/md_line_hash。force 时先删 `md_file_path=filePath` 的所有任务再全量导入。
- **exportToMd**：generateMdFromTasks 整文件覆盖写，回填所有导出任务的 md_file_path（不写 hash）。
- **mergeTasksToMd**：planMdMerge + 批量 rebind（写 md_file_path+md_line_hash）+ 覆盖写文件。
- **syncWithMd(filePath, regenerateMd=true)**（双向）：
  - 文件不存在 → 把绑定任务 exportToMd 后返回。
  - Phase 1（树递归）：checked bullet——匹配到的任务若非 archived → **删除**（deleted++；已 archived 不动，不进 processed）；不从 [x] 建任务，子节点递归 parent 不变（上提）。未勾选：匹配 → computeTaskRepairs 应用更新（updated++、conflicts 收集）并进 processed；未匹配 → 建任务（queued、sort_order=lineIndex、绑定 hash）进 processed。子任务递归用真实/新建父 id。
  - Phase 2 删除：绑定本文件、title 非空白（空白=未保存草稿豁免）、未被处理、且 `md_line_hash` 不在文件 hash 集合 → 删除（deleted++）。注意：**只删 hash 消失的**，未处理但 hash 仍在（如 checked+archived）保留。
  - Phase 3：regenerateMd=true（手动同步）才 mergeTasksToMd 回写；**watcher 路径传 false**（MD→DB 单向，保护用户编辑）。
- **appendTaskToMd**：空 title 跳过；有父且父有 hash → 插在**父行紧后**（lineIndex+1，注意与 merge 的"子群末尾"不同）、缩进父 depth+1；否则追加末尾。回写 md_file_path+hashContent(title)。
- **updateTaskInMd**（改名就地重写）：按 md_line_hash 定位行；check 前缀：newStatus='archived'→`[x]`、'active'→`[ ]`、否则保持原 checked 状态；保留缩进与符号；hash 更新为新 title。
- **removeTaskFromMd**：hash 定位，失败回退 hashContent(title) 定位；splice 单行（**不删子树**）。

### 5.6 autoSync.ts（AutoSyncManager）

参数：`FILE_DEBOUNCE_MS=2000`、`TASK_DEBOUNCE_MS=500`、`SUPPRESS_DELAY_MS=1500`、轮询 `3000ms`。

- `start(folder)`：stop 后启用；filePath=folder/epochtodo.md；记录初始 mtime；**initialSync**：文件已存在→`syncFromFile()`（MD→DB 导入），不存在→`exportTasks()`（DB→MD 生成）；然后开 watcher。
- **watcher = 监听目录**（非文件，抗 Windows 原子替换）；`filename === 'epochtodo.md'` 才触发；watcher 创建失败 2s 重试；同时 mtime 轮询兜底（mtime 变化触发；`lastPollMtime===0` 的首次观察只记录不触发）。
- **debouncedSyncFromFile**：2000ms 防抖；若 suppressWatch 期间到期 → **不丢弃事件**，以 500ms 短延迟重排，直到 suppress 解除再执行（用户可能在我方写文件窗口内又编辑）。
- **syncFromFile**：suppressWatch=true → `syncWithMd(path, false)`（不回写）→ onSyncComplete（广播 fetch-tasks）→ finally `setTimeout(1500)` 解除 suppress。
- **triggerExport**（任务变更后，broadcastFetchTasks 调用）：500ms 防抖 → exportTasks。
- **exportTasks**：并发锁 exportInProgress（占用则 300ms 后重排）；先算 `tasksToMdPreview`（与 generateMdFromTasks 相同规则的确定性预览字符串），与 lastWrittenContent 相同则**跳过写**；否则 suppressWatch=true → `mergeTasksToMd` → 记录 lastWrittenContent/lastSyncTime → finally 1500ms 解除 suppress。
- main.ts 挂钩：`update-task` 改名（非层级变更）→ 先 `updateTaskInMd`（防 merge 追加重复行+watcher 复活旧标题）；`updates.parent_id !== undefined` → DB 更新后 `moveTaskSubtreeInMd`；`delete-task` → 先 `removeTaskFromMd`（需要 DB 里的 hash）再删库。设置持久化：`md-sync-enabled`（bool）、`md-sync-folder`（路径）。

---

## 6. 优先级与层级（src/shared/priority.ts、hierarchy.ts、renderer/utils/buildTaskTree.ts）

- **countBangs(title)**：统计标题中**任意位置**的 `!` 个数（不限于结尾）。
- **computeBangPriorities(tasks)**：subtree-max——`eff(t) = max(countBangs(t.title), eff(所有子))`，memo 化；`visiting` 集合防环（环上节点返回 0）。返回 `Map<id, number>`。**只向上传播不向下**（父的 !! 不抬子）。
  - 使用方：任务树同级排序、Dashboard 队列、Spotlight 建议、BridgeState.priority。
  - **例外：Overlay 的 3 个队列槽位只用任务自身的 bang 数**，不做聚合（注释明示）。
- **buildTaskTree**（渲染端）：过滤非 archived；parent_id 不在集合（孤儿/父已归档）→ 提升为根；同级排序键（严格）：**prio 降序 → sort_order 升序 → created_at 升序**；深度递归赋 depth。
- **getAncestorChain(tasks, taskId, maxDepth=5)**：root→直系父 顺序；visited 防环；链长 < maxDepth 截断；父缺失即停返回部分链。
- **fitBreadcrumbLevels(titleWidth, levelWidths[], sepWidth, availableWidth)**：从最近的父开始（levelWidths 末→首）逐级尝试加入（cost=sepWidth+width），**放不下即停**（全有或全无，不截半级），返回可容纳级数。

---

## 7. Webhook 服务器（electron/server.ts）

- 端口 **62222**，监听 `0.0.0.0`。`EADDRINUSE` 时打印明确警告（另一实例占用，AI 提醒将收不到）。
- CORS：`Access-Control-Allow-Origin: http://localhost:*`（字面量）、Methods `GET, POST, OPTIONS`、Headers `Content-Type`；OPTIONS → 200 空体。
- **payload 解码**：所有 POST 先 `Buffer.concat(chunks)` **再** `toString('utf8')`（禁止逐 chunk 解码——多字节跨 TCP 包会产生乱码）。
- 路由表（pathname 去 query；**`/hook` 例外：精确匹配 `req.url`，带 query 会 404**）：

| 方法/路径 | 行为 | 错误 |
|---|---|---|
| GET /bridge/state | `getBridgeState()` → 200 JSON（容忍 query） | 500 `{error}` |
| GET /bridge/reminders | `drainAiFeed()` → 200 `{reminders:[...]}`（旧→新、取后置 announced） | 500 |
| POST /bridge/tasks | validateBridgeTaskInput → createBridgeTask → broadcastFetchTasks → 200 `{created, task}` | 400 `{error}`（不广播） |
| POST /hook | 见下 | |
| 其他 | 404 空体 | |

- `/hook` 分支顺序（JSON.parse 失败 → **500** `{error:'Invalid JSON or Server Error'}`）：
  1. `kind === 'ai'` → handleAiReminder；成功 200 `{success:true}`；抛错 400 `{error: message}`（如缺 source/title）。
  2. `kind === 'ai-dismiss'` → dismissAiReminder（source/title 非 string 置 undefined、`force = data.force === true`）；成功 200 `{success:true, dismissed_tasks}`；抛错 400。
  3. **训练更新判定**：`model_name || gpu_name || eta || metrics || (task_id && !message)` 为真 → updateTrainingStatus；true → 200 `{success:true, message:'Training status updated'}` + broadcastFetchTasks；false → **404** `{error:'Task not found'}`。
  4. 纯通知：`{title, message}` → triggerExternalNotification(title, message)（渲染为 type='notification' 的伪任务、id=`-1*Date.now()`、走 `timer:ended` 弹硬提醒）；缺 title → 400 `{error:'Title is required'}`。

---

## 8. 窗口管理（electron/windows.ts、main.ts）

| 窗口 | 创建参数 | 行为 |
|---|---|---|
| **dashboard** | 1200×800，普通框，show:false | ready-to-show 后 show；close 时非退出则 **hide 不销毁**；dev 模式开 DevTools |
| **spotlight** | 800×600，frame:false、transparent:true、resizable:false、alwaysOnTop、skipTaskbar、backgroundColor '#00000000' | 全局快捷键（默认 `Alt+Space`，settings `global_shortcut` 可改，register 失败记日志；改键时 unregisterAll 重注册）切换显隐；每次显示都居中到**光标所在显示器**（bounds 中心对齐 display.bounds）；销毁后重建。hide 时清理空白标题任务 |
| **reminder** | 500×450，frame:false、transparent、alwaysOnTop、skipTaskbar、**focusable:true、hasShadow:true** | 显示时居中到光标所在显示器；`setAlwaysOnTop(true,'screen-saver')` + `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})` + `flashFrame(true)`；blur 后 100ms 重新置顶；已存在则 show+focus 不重建；`timer:ended` 软判定见 §2.5（内容延迟 1s 发送） |
| **overlay** | 尺寸/位置 = settings `overlay_bounds`（默认 `{x:100,y:100,width:350,height:250}`）；frame:false、transparent、alwaysOnTop、skipTaskbar、**focusable:false、hasShadow:false** | **多显示器 bounds 校验**：`boundsOnAnyDisplay`（与任一 display.workArea 矩形相交）不通过 → 回退默认值（防拔显示器后 OS 钳制+缩放被持久化）。`setIgnoreMouseEvents(true,{forward:true})`（点击穿透可由 IPC 切换）。**尺寸记忆**：moved/resized 触发 1000ms 防抖保存；创建后 **5000ms 宽限期内不保存**（DPI 启动调整）；bounds 不在任何显示器上不保存。置顶维持：show/focus/restore/move/resized 事件 + **每 30s** 定时 `setVisibleOnAllWorkspaces + setAlwaysOnTop('screen-saver')`；托盘"Re-assert Overlay Topmost"手动补救。reset-overlay-position：主显示器 workArea 居中 350×250 并持久化 |
| **tray** | 16×16 icon，tooltip 'DayFlowGemini' | 菜单：Open Dashboard / Re-assert Overlay Topmost / Quit（置 isQuitting）；单击=show dashboard |

- **跨窗口广播**：TimerManager broadcaster → dashboard+spotlight+overlay（reminder 特判）；`broadcastFetchTasks` = 三窗发 `fetch-tasks` + `autoSync.triggerExport()`。`ai:reminder-dismissed` 若 `dismissed>0` 额外 `reminder.hide()`。
- 生命周期：`before-quit` 置 isQuitting；`window-all-closed` 非 macOS 退出；`activate`（mac）重建 dashboard+spotlight。
- dev 截图工具链（CAPTURE_SHOTS）与主题无关，略。

---

## 9. wandb 轮询（electron/wandb/client.ts、poller.ts）

- **GraphQL**：`https://api.wandb.ai/graphql`，Basic auth = base64(`api:{apiKey}`)；字符串值做 `\` 与 `"` 转义。
  - `getRecentProjects(entity, limit=5)`：`projects(entityName, first:limit, order:"-lastActive")` → 名称列表（poller 用 maxProjects=5）。
  - `getRunningRuns(entity, project)`：`project.runs(first:50, order:"-createdAt")` 取 name/displayName/state/host/config/summaryMetrics/createdAt/updatedAt，**过滤 state==='running'**；config 与 summaryMetrics 是 JSON 字符串需二次 parse（失败回退 {}）；run.id=GraphQL name、run.name=displayName||name；url=`https://wandb.ai/{entity}/{project}/runs/{id}`。
  - `getRunState`：单 run state 查询，异常返回 null。
- **WandbPoller**：默认 `intervalMs=30000`（30s），start 立即 poll 一次；`polling` 标志防重入；`trackedRuns: Map<runId, {project, run}>`。
  - 每轮：收集当前所有项目的 running runs（seenRunIds）；对 trackedRuns 中**本轮消失**的 run 调 getRunState——**返回 null（API 瞬时错误）则继续跟踪不判 finished**（防误归档）；有具体 state → 报 finished 并移出跟踪。
  - 仅当 active 或 finished 非空才回调 `{active, finished}`。
- **GPU 卡数据来源**：GPU 面板的卡= `gpus` 表行。wandb 路径下**每个 active run 一张卡**：`GpuService.createGpu(run.name)`（host_id=`wandb:{project}:{run.id}`，颜色随机默认色）；训练任务按 run.name 精确匹配（type='training'、非 archived）或新建（skipDedup=true + is_webhook=1）；task.gpu_id 绑定、status='active'、setGpuBusy。卡上指标= run.summaryMetrics（原样存入 TrainingStatus.metrics，含 wandbUrl）。webhook 路径 GPU 卡按 payload `gpu_name`(+host_id) 自动建，指标= payload.metrics/eta。每轮结束清理不在 active∪finished 的 wandb GPU（防幽灵卡）。
- **与 webhook 训练更新的去重**（manager 侧两级）：① trainingStatus 中存在任一 source==='wandb' 条目 → webhook `updateTrainingStatus` **整体短路**（return true 不处理）；② 解析出的任务已有 source==='wandb' 条目 → 跳过该次更新。反向：wandb 状态直接覆写 trainingStatus 并广播。
- **crashed/killed**：run 进 finished 集但 state 为 crashed/killed 时**不删卡不归档**，仅把内存条目标 stalled 并广播（走停滞 nag 流程）；正常 finished → 删 GPU 卡、任务 archived、清 trainingStatus。
- `initWandb`（构造时/`wandb:update` IPC）：先 `cleanupWandbGpus()`；settings `wandb_api_key` + `wandb_entity` 齐备才 startWandbPolling（restart 语义：先 stop 清 trackedRuns）。

---

## 10. IPC 面（src/shared/ipc-types.ts、electron/preload.ts、main.ts）

方向约定：`invoke` = renderer→main 请求/响应（ipcMain.handle，异常统一包成 `{success:false,error}`）；`send` = renderer→main 单向；`on` = main→renderer 广播。

**任务域**
- invoke：`get-tasks`、`create-task(title,tag?,type?,projectId?,parentId?,skipDedup?)`、`update-task(id,updates)`、`set-side-focus(id,enabled)→boolean`、`delete-task`、`delete-all-tasks`、`get-suggestions(maxDuration?)`。
- send：`timer:start-focus(taskId)`（含副焦点轮换：清目标的 side 标志、旧 focus 若非自身则尝试转为 side——满 2 个静默跳过）、`timer:stop-focus`、`timer:complete-task`、`timer:start-wait(taskId,durationSec)`、`timer:cancel-wait`、`timer:add-memo(taskId,content)`。
- invoke：`timer:stop-training(taskId, forceComplete?)`。
- on：`timer:update`、`timer:ended(taskId, task)`、`fetch-tasks`。

**副焦点/overlay 域**：send `set-overlay-ignore-mouse(ignore)`、`reset-overlay-position`。

**提醒/AI 域**
- send：`reminder:hide`、`reminder:snooze(taskId,minutes)`、`ai:reminder-dismiss({id?|source?,title?,force?})`。
- invoke：`ai-promote(source,title,detail?,link?)`、`open-external(url)`（仅 http/https）。
- on：`ai:reminder(reminder)`、`ai:reminder-dismissed({id?,source?,title?,force?})`、`reminder:repeat`（**仅预载声明，主进程从未发送**——遗留接口）、`timer:training-update(status)`。

**GPU/训练域**：invoke `get-gpus`、`create-gpu`、`delete-gpu`（联动清 trainingStatus）、`wandb:test(entity,apiKey)→{valid,projectCount,hostname}`；send `gpu:assign-task(taskId,gpuId,durationMinutes)`（→ startTraining，分钟×60）、`wandb:update`。

**项目/历史/设置/系统域**：invoke `get-projects`、`create-project`、`update-project`、`delete-project`、`get-history(dateStr?)`（start_time LIKE `YYYY-MM-DD%`）、`delete-history`、`get-settings(key,default?)`、`update-setting(key,value)`（`global_shortcut` 变更即时重注册）、`register-shortcut`、`unregister-shortcuts`、`get-auto-launch`、`set-auto-launch`、`export-data`/`import-data`（文件对话框，导入自动备份旧库并返回 needsRestart）。

**跨应用分发域**：invoke `task:identify-target`（150ms 延迟后识别前台窗；**自身进程窗口返回 null**）、`task:dispatch(taskId)`（延迟→识别→`dispatched_target` JSON 覆盖写入"last dispatch wins"→simulatePaste 粘贴剪贴板里的标题；self-window 返回 `{ok:false,error:'self-window'}`）。

**Scheduler 域**（invoke）：`scheduler:get/create/update/delete-gpus`、`scheduler:get/create/update/delete-tasks`、`scheduler:get/create/update/delete-assignments`、`scheduler:clear-assignments`（create-assignment 冲突返回 `{error}`）。

**MD 同步域**（invoke）：`md-sync:select-folder`（目录对话框）、`md-sync:check-file`、`md-sync:import(filePath,force,rootParentId?)`、`md-sync:export(filePath,taskIds[])`、`md-sync:sync(filePath)`（regenerateMd=true）、`md-sync:check-duplicates(titles[])`、`md-sync:read-file`、`md-sync:set-config(enabled,folderPath)`、`md-sync:get-status`。

**HTTP 面**（非 IPC，见 §7）：`GET /bridge/state`、`GET /bridge/reminders`、`POST /bridge/tasks`、`POST /hook`。

---

### 重实现时最容易漏掉的对齐点（速查）

1. focus 结算的 **180 秒门槛**只决定记账与否，两种情况都置 queued + last_focused_at；时长向**所有祖先**累加。
2. 计时到期**不删 timer 行、不改 status**；软提醒（type='reminder'）永不弹窗/发声，靠横幅+nag（`overdueMinutes % 15 === 0` 且 >0）。
3. `startWait` 会先结算 focus（防丢时长）；每任务 timer 行唯一、start* 先删后插。
4. completeTask 归档整棵子树（深度上限 20）且焦点移交父任务。
5. AI 硬提醒 = success/needs_input/review → 持久 `🤖 source · title` notification 任务 + 硬弹窗；ai-dismiss 删除匹配任务**不看 force**，force 只控制渲染端是否连 needs_input/review 卡一起清。
6. wandb 对 webhook 有**通道级**压制（任一 wandb 条目即忽略全部 webhook）。
7. mdSync hash=md5(trim)前 16 hex；watcher 同步只 MD→DB（regenerateMd=false）；改名/改层级/删除各有专属 MD 钩子，缺一则 watcher 会把变更"修"回去。
8. Spotlight 时间表达式默认单位分钟；backtick GPU 把 CREATE/FOCUS 升级为 TRAINING；`@` 单独成句推断 SUSPEND；main+time 无前缀推断 REMINDER（默认 30 分钟）。
9. overlay bounds 双保险（显示校验 + 5s 保存宽限），置顶每 30s 重申。
10. webhook `/hook` 用 `req.url` 精确匹配（不兼容 query），body 必须先拼 Buffer 再 UTF-8 解码。
