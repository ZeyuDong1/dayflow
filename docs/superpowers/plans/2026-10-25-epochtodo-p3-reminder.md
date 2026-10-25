# EpochToDo 融合 P3：装配 + IPC 面 + Reminder 硬提醒窗 实现计划

> **面向 AI 代理的工作者：** 复选框跟踪，TDD 循环；窗口视觉部分用 DAYFLOW_SCREENSHOT 自测钩子验证。本机无 executing-plans 子技能。

**目标：** 把任务域接进 Dayflow 主进程生命周期（装配/广播/server 启动），暴露完整 IPC 面，并实现 Reminder 硬提醒窗——到期硬提醒真实弹窗可用。

**架构：** `src/main/todo/wiring.ts` 产出 `TodoIpcDeps` 并把 broadcast 映射到所有窗口 `webContents.send`；`registerTodoIpc(registry, deps)` 以纯注册函数实现（可无 Electron 测试）；Reminder 窗为独立 BrowserWindow 加载同一 renderer bundle（`?win=reminder`），preload 扩展 `window.dayflow.todo.*`。

**技术栈：** electron-vite 现有管线、TypeScript、vitest（注册函数/格式化纯函数可测）。

**规格：** 语义规格 §2.5（到期分流/Reminder 行为）、§8（窗口参数）、§10（IPC 面）+ 功能清单第五节。

## 全局约束

- Reminder 窗行为逐条对齐：Enter=完成（training→stopTraining、无项目 standard→先选项目、gpu-idle/notification 仅关闭）、Esc=training 负时 15 分钟（可选 5/30）/其余关闭、snooze 默认 5 分钟、C5-E5-G5 三音琶音后每 5 秒循环、standard 排末尾为"当前"、空列表自动隐藏。
- 窗口参数照语义规格 §8：500×450、frameless、transparent、alwaysOnTop('screen-saver')、skipTaskbar、focusable、hasShadow、居中到光标显示器、blur 后 100ms 重新置顶、flashFrame。
- 软硬判定：`task.type === 'reminder'` 不弹窗（软路径只走横幅，P4 起 UI）。
- IPC 命名 `todo:*` 小写；preload 只经 contextBridge；文案中文。

## 审查重点（Review Focus）

1. 窗口未加载完成就 send 的竞态（源码用延迟 1s 重发）——装配层对 reminder 窗做 ready 队列或延迟重发，测试钉住。
2. 多窗口广播时已销毁窗口——`isDestroyed()` 防御（现有 ipc.ts 同款）。
3. 无项目 standard 完成必须先选项目（Enter 不能直接归档）——交互逻辑测试钉住决策函数。
4. 训练任务在 Reminder 窗的完成走 stopTraining（含跟进任务生成），Esc 负时 15 分钟默认——测试钉住。
5. 音效每 5 秒循环直到列表清空、隐藏即停——渲染端逻辑测试钉住计时器启停。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| 创建 `src/main/todo/wiring.ts` | `createTodoRuntime(db)`：装配 domain+server、broadcast→所有窗口、生命周期 start/stop |
| 创建 `src/main/todo/ipc-registry.ts` | `registerTodoIpc(reg, deps)`：纯注册函数（`reg.handle/on` 注入），无 Electron 依赖 |
| 创建 `src/main/todo/reminder-window.ts` | Reminder 窗创建/复用/居中/置顶维持/软硬判定入口 |
| 创建 `src/main/todo/reminder-logic.ts` | 纯函数：`resolveReminderAction`（Enter/Esc 语义）、`getTimerDisplay`（格式化） |
| 修改 `src/main/ipc.ts`、`src/main/index.ts` | 装配 wiring + 注册 IPC + quit 时 stop |
| 修改 `src/preload/index.ts` | `window.dayflow.todo.*` 命令面 |
| 创建 `src/renderer/src/reminder/`（App 分支） | Reminder 窗 UI（音效/键盘/列表/Assign Project） |
| 测试：`tests/todo/reminder-logic.test.ts`、`tests/todo/ipc-registry.test.ts` | 纯函数与注册表 |

---

### 任务 1：reminder-logic 纯函数（动作语义 + 计时显示）

**文件：** 创建 `src/main/todo/reminder-logic.ts`、`tests/todo/reminder-logic.test.ts`

- [x] **步骤 1：编写失败的测试**

```ts
describe('getTimerDisplay', () => {
  it('倒计时优先：target-now 按 d/h/m 分段；≤-2s "DONE"；≤0 "00:00"', () => { ... })
  it('秒表：total_duration + (now-started)，D:HH:MM:SS 超一天', () => { ... })
})
describe('resolveReminderAction', () => {
  it('Enter：training→stop-training；gpu-idle/notification→dismiss；无项目 standard→select-project；其余→complete', () => { ... })
  it('Esc：training→snooze(15)；其余→dismiss', () => { ... })
  it('snooze 按钮：默认非 training 5 分钟；training 负时 5/15/30 可选', () => { ... })
})
```

- [x] **步骤 2：运行验证失败**
- [x] **步骤 3：实现** `getTimerDisplay(task, now): string`（语义规格 §5.4）与 `resolveReminderAction(input: {key:'enter'|'esc'; taskType; hasProject; }): Action`（Action = `{kind:'complete'|'dismiss'|'stop-training'|'select-project'|'snooze'; minutes?: number}`）。
- [x] **步骤 4：运行验证通过**
- [x] **步骤 5：Commit** — `feat(todo): Reminder 动作语义与计时显示纯函数`

### 任务 2：IPC 注册面（纯注册函数）

**文件：** 创建 `src/main/todo/ipc-registry.ts`、`tests/todo/ipc-registry.test.ts`

- [x] **步骤 1：编写失败的测试**（假 registry 收集 handle/on 注册）

```ts
it('注册域齐全：tasks/timer/ai/gpu/settings/md(P4占位)/bridge 查询', () => { ... })
it('handle 转发到 domain 方法并回传（create-task/update-task/set-side-focus/timer:stop-training 等）', () => { ... })
it('timer:start-focus 带副焦点轮换：清目标 side 标志、旧 focus 降级为 side（满 2 静默跳过）', () => { ... })
```

- [x] **步骤 2：运行验证失败**
- [x] **步骤 3：实现** `registerTodoIpc(reg: {handle(ch, fn): void; on(ch, fn): void}, deps)`——通道清单照语义规格 §10（映射到 domain 方法），`timer:start-focus` 实现副焦点轮换（语义 §10 任务域注）。
- [x] **步骤 4：运行验证通过**
- [x] **步骤 5：Commit** — `feat(todo): IPC 注册面（含副焦点轮换）`

### 任务 3：装配 + Reminder 窗

**文件：** 创建 `src/main/todo/wiring.ts`、`src/main/todo/reminder-window.ts`；修改 `src/main/ipc.ts`、`src/main/index.ts`、`src/preload/index.ts`、renderer

- [x] **步骤 1：** `wiring.ts`：`createTodoRuntime()` 从 `db` 单例装配 `createTodoDomain`，broadcast → `BrowserWindow.getAllWindows()` 的 `webContents.send`（审查重点#2 防御）；`start()` 启 server(62222)+timerManager.start()；`stop()` 反向。reminder 窗口未 ready 的 send 进队列、ready 后 flush（审查重点#1）。
- [x] **步骤 2：** `reminder-window.ts`：`showReminderWindow(task)`（语义规格 §8 参数 + 居中光标显示器 + flashFrame + blur 100ms 重置顶 + 复用不重建）；软判定 `type==='reminder'` 不弹；`timer:ended` 路由在此（含 gpu-idle/notification 伪任务）。
- [x] **步骤 3：** renderer Reminder UI：`?win=reminder` 分支；大卡+Other Pending 列表+按钮组（COMPLETE/Continue/+5min/+30min、training 特例）+ Assign Project 内嵌 + 音效（三音琶音、5s 循环、清空即停，审查重点#5）+ 键盘（resolveReminderAction 驱动，审查重点#3/#4）。
- [x] **步骤 4：** preload 扩展 `window.dayflow.todo.*`（任务/计时/ai/gpu/设置键）。
- [x] **步骤 5：** 自测：`DAYFLOW_SCREENSHOT` 钩子对 reminder 窗截图核对；`npm test` + `npm run typecheck` 全绿。
- [x] **步骤 6：Commit** — `feat(todo): 装配/IPC 接线 + Reminder 硬提醒窗`

---

## 执行交接

计划完成，保存于 `docs/superpowers/plans/2026-10-25-epochtodo-p3-reminder.md`。按用户"基于这个来实现"的指示，原生执行继续。P4=Spotlight 窗；P5=Overlay 窗；P6=mdSync/wandb；P7=任务页/设置/时间轴窄条+合规比例/术语改名；P8=验收。
