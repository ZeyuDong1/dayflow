# EpochToDo 融合 P4：Spotlight 窗口 实现计划

> **面向 AI 代理的工作者：** 复选框跟踪，TDD 循环；窗口视觉用 DAYFLOW_SCREENSHOT 自测。

**目标：** 实现 Alt+Space Spotlight 全局命令栏：命令文法已备（P1 commands.ts），本计划补 Enter **执行语义**（纯逻辑）、窗口管理（热键/显隐/居中/草稿清理）与完整 UI（任务树/建议/横幅/AI 卡/完成确认/GPU 选择）。

**架构：** `src/main/todo/execute-command.ts` 纯函数把 `ParsedCommand` + 上下文（活动任务/高亮建议/领域操作接口）映射为一串领域调用；窗口管理 `spotlight-window.ts`（模式照 reminder-window）；UI `src/renderer/src/SpotlightWindow.tsx`（`#/spotlight` hash 分流）。

**规格：** 语义规格 §4.1-§4.3（文法已实现；执行语义为准）、功能清单第三节（用户裁决版）。

## 全局约束

- Enter 执行语义逐条对齐语义规格 §4.3（含水槽用例 `! finetune bert\`A100 @90m $LLM!v2` 的完整执行路径）；REMINDER 默认 1800s、TRAINING GPU 分配缺省 60 分钟；`sub` 写备忘 `Context: {sub}`。
- 空白标题草稿（新建即建、隐藏时清理：status 非 active 非 archived 且 title 空 → 删）。
- 命令执行后输入清空、50ms 后隐藏窗口；`$项目` 模糊 `includes` 匹配、`` `GPU `` 模糊匹配（不匹配仅 warn 任务留队列）。
- UI 文案中文、设计令牌样式；全局热键默认 `Alt+Space`（设置可改在 P7，本计划留 IPC 口）。

## 审查重点（Review Focus）

1. FOCUS"切换+挂起"原子性：`!新任务 @25m` 必须先挂起旧任务（结算不丢时长）再专注新任务——测试钉住顺序与状态。
2. 子任务"同级"语义：有活动任务时父=activeTask.parent_id ?? activeTask.id（活动任务是子则建兄弟）——测试钉住。
3. 目标解析歧义：FOCUS 有高亮用高亮；否则标题**精确不区分大小写**匹配（限定项目、排除 archived）；未命中才新建——测试钉住三层。
4. GPU 分配失败（模糊不中）不得吞任务：任务保持 queued、仅记录警告——测试钉住。
5. 草稿清理不得误删真实任务（只删空白标题且非 active/archived）——测试钉住。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| 创建 `src/main/todo/execute-command.ts` | `executeCommand(parsed, ctx): ExecResult`（纯函数）+ `cleanupDraftTasks(tasks)` |
| 创建 `src/main/todo/spotlight-window.ts` | 热键注册/显隐切换/居中光标显示器/隐藏时草稿清理 |
| 创建 `src/renderer/src/SpotlightWindow.tsx` | 完整 UI（输入/芯片/Active/任务树/建议/横幅/AI 卡/Tasks Ready/完成确认/GPU 选择） |
| 修改 `src/main/todo/wiring.ts`、`src/preload/index.ts` | 装配 spotlight 窗、`todo.*` 补 Spotlight 所需通道（create-task/suggestions/gpus 等已有） |
| 测试：`tests/todo/execute-command.test.ts` | 执行语义全量 |

---

### 任务 1：executeCommand 纯逻辑

**文件：** 创建 `src/main/todo/execute-command.ts`、`tests/todo/execute-command.test.ts`

- [x] **步骤 1：编写失败的测试**（ctx 用假 DomainOps 记录调用序列）

```ts
describe('executeCommand', () => {
  it('MEMO → appendMemo(活动任务)', ...)
  it('SUSPEND：有活动 → startWait(活动, time)；无活动 → 建"提醒"reminder 任务并 startWait', ...)
  it('FOCUS 切换+挂起原子性（审查重点#1）：先 startWait(旧,time) 再 startFocus(目标)', ...)
  it('FOCUS 无 time → startFocus；有 time 无活动 → startWait(目标)', ...)
  it('CREATE → 仅创建入队置 next_action', ...)
  it('REMINDER → 建 reminder 任务并 startWait(缺省 1800s)', ...)
  it('TRAINING 有 time 无 GPU → 返回 {needGpuPick:true}；选定后建 training+assignTaskToGpu(ceil(min),缺省60)', ...)
  it('目标解析三层（审查重点#3）：高亮 > 精确标题(不分大小写,限项目,排除archived) > 新建；命中/新建都置 next_action', ...)
  it('子任务同级语义（审查重点#2）与 Context 备忘', ...)
  it('GPU 模糊不中（审查重点#4）：任务留队列仅 warn', ...)
})
describe('cleanupDraftTasks', () => {
  it('只删空白标题且非 active/archived（审查重点#5）', ...)
})
```

- [x] **步骤 2：运行验证失败**
- [x] **步骤 3：实现** `executeCommand(parsed: ParsedCommand, ctx: ExecCtx): ExecResult`——ctx 提供 `{activeTask, highlighted, domainOps}`；domainOps 接口（createTask/updateTask/appendMemo/startFocus/startWait/assignTaskToGpu/getTasks）由 wiring 适配真实 domain。语义照语义规格 §4.3 逐分支。
- [x] **步骤 4：运行验证通过**
- [x] **步骤 5：Commit** — `feat(todo): Spotlight 命令执行语义`

### 任务 2：窗口管理 + 热键

**文件：** 创建 `src/main/todo/spotlight-window.ts`；修改 `wiring.ts`、`ipc-registry.ts`（`todo:toggle-spotlight`）

- [x] **步骤 1：** `spotlight-window.ts`：`toggleSpotlight()`（显隐切换、每次显示居中到光标显示器、销毁重建）、`registerShortcut(accelerator)`/`setShortcut`（unregisterAll 重注册）、隐藏时 `cleanupDraftTasks`。
- [x] **步骤 2：** wiring 装配（`globalShortcut.register('Alt+Space', toggleSpotlight)`，失败仅日志）；`will-quit` 注销。
- [x] **步骤 3：** 自测：构建后手按 Alt+Space 或 DAYFLOW_SHOT_JS 注入验证显隐；typecheck/test 全绿。
- [x] **步骤 4：Commit** — `feat(todo): Spotlight 窗口与全局热键`

### 任务 3：Spotlight UI

**文件：** 创建 `src/renderer/src/SpotlightWindow.tsx`；修改 `main.tsx`、`styles.css`、`preload/index.ts`

- [x] **步骤 1：** UI 结构照功能清单第三节：输入栏（命令芯片）、Active 区（FOCUS 卡+waiting 行）、Training chips、Bullet 任务树（Tab/Shift+Tab 保持焦点、◎、Timer 按钮、右键菜单）、过期提醒横幅、AI 卡、Footer 速查、Tasks Ready 弹层、完成确认（含 Select Project）、GPU 选择模式。
- [x] **步骤 2：** 键盘：↑↓/Ctrl+1..9/Enter/Esc/Tab/Shift+Tab/Backspace/Ctrl+Enter（Bullet 编辑器语义照语义规格 §4.3）。
- [x] **步骤 3：** 自测截图（DAYFLOW_SCREENSHOT 对 #/spotlight）；typecheck/test 全绿。
- [x] **步骤 4：Commit** — `feat(todo): Spotlight 界面（任务树/建议/横幅/弹层）`

### 任务 4：收尾

- [x] **步骤 1：** AGENTS.md 现状更新；计划勾选；全量回归。
- [x] **步骤 2：Commit** — `docs(todo): P4 收尾`

---

## 执行交接

计划完成，保存于 `docs/superpowers/plans/2026-10-25-epochtodo-p4-spotlight.md`。P5=Overlay 窗；P6=mdSync/wandb/GPU 卡；P7=任务页/设置 tab/时间轴窄条+合规比例/术语改名；P8=验收走查。
