# EpochToDo 功能并入 Dayflow — 设计文档

- 日期：2026-10-25
- 状态：草稿（待整合功能盘点、待建造者检查）
- 分支：`feat/epochtodo-integration`（worktree `dayflow-win-epoch`）
- 功能基线：EpochToDo v1.4.3（`C:\Users\Zeyu\.zcode\workspace\default\EpochToDo`）

## 1. 意图与缘由

Dayflow for Windows 是被动记录型工作日志（自动追踪窗口活动 → LLM 归类 → 时间轴/站会/回顾），它知道用户"做了什么"，但不管用户"正在做什么、该做什么"。EpochToDo 是主动管理型任务工具（任务树、专注计时、Spotlight 快速切换、悬浮 Overlay、AI 提醒、训练任务追踪），面向高频上下文切换（尤其是跑训练的研究者）。

把 EpochToDo 的**全部功能**并入 Dayflow，形成单一应用：时间轴（过去）与任务/专注（现在与未来）在一个闭环里互相佐证——专注会话落到时间轴上，时间轴证据反哺任务回顾。用户要求：**功能必须全量对齐（"功能都对"是唯一验收标准），实现方式允许完全重写，其余一切（技术栈、代码结构、视觉风格）由建造者自行决定。**

## 2. 目标 / 非目标 / 反目标

### 目标

- EpochToDo v1.4.3 的每一个用户可见功能在合并后的 Dayflow 里行为等价地存在，逐条对照功能清单验收。
- Dayflow 现有全部功能（追踪、归类、规则引擎、时间轴 LOD、站会、周报、对话、项目树合并、导出）不退化。
- 三条外部生态协议**逐字节兼容**（见 §3 约束 4）：webhook 62222、mdSync 文件格式、VS Code 调试通知插件。

### 非目标

- 不做像素级视觉复刻：EpochToDo 的深色 Tailwind 界面按 Dayflow 暖色设计令牌重绘，用户明确表示视觉"无所谓"。
- 不保留 EpochToDo 的代码结构、目录布局、依赖选型；以 Dayflow 的架构惯例为准重实现。
- 不移植 macOS/非 Windows 平台支持。
- 不做两个应用的数据迁移工具（EpochToDo 数据库不导入；从零开始）。

### 反目标（做到即算失败）

- 引入任何**需要现场原生编译**的依赖（红线：机器无 VS Build Tools，`npmRebuild:false` 固定）。better-sqlite3、kysely 不得进入依赖树。
- 为移植而改变 62222 webhook 的 payload 形状/路由语义，或改变 mdSync 文件格式与双向规则（外部工具、VS Code 插件、用户的 Obsidian 库都依赖它们）。
- 以任何形式削弱 Dayflow 的核心追踪/归类链路（windows-poll、规则引擎、LOD 几何）。
- 界面文案语言混杂：合并后 UI 全部中文。

## 3. 约束

1. **无原生编译依赖**：数据库用 Dayflow 现有 sql.js 封装（`src/main/db.ts`，全内存 + 防抖落盘）；EpochToDo 的 SQL 服务层重写为其上的纯 SQL 模块。测试框架选 vitest（纯 JS）。
2. **前台窗口一律走 koffi FFI**（`src/main/foreground.ts`）：EpochToDo 用的 `active-win` 在 Electron 主进程永久挂起（AGENTS.md 坑#1），移植时凡取前台窗口处必须替换。
3. **UI 惯例**：React 19 + electron-vite + 自研 CSS 设计令牌（暖色奶油/蜜桃 + LXGW WenKai），动效只动 transform/opacity/filter，`prefers-reduced-motion` 已全局支持；界面全中文；IPC 经 `preload/index.ts` 的 `window.dayflow.*` 桥（新功能挂同一命名空间）。
4. **外部协议兼容矩阵**（反目标的正面表述）：
   - `POST http://127.0.0.1:62222/hook` 全部 payload（通用通知、训练状态、`kind:"ai"` 软提醒、`kind:"ai-dismiss"`）形状与语义原样；
   - 桌面宠物桥 `GET /bridge/state`、`GET /bridge/reminders`、`POST /bridge/tasks` 行为原样（含 aiFeed 的 announced 去重语义）；
   - mdSync 的 `epochtodo.md` checkbox bullet 格式、双向同步触发/防抖/匹配/删除语义原样；
   - `vscode-debug-notifier/` 插件零改动可用（webhook 兼容即满足）。
5. **窗口模型**：Dayflow 主窗口 + EpochToDo 的三个辅助窗口（Spotlight、Overlay、Reminder）按 Electron 45 重建；多显示器 bounds 校验逻辑（v1.4.2 修复）必须保留。
6. **数据目录**：延续 `%APPDATA%\Dayflow\`，新增表落同一 `dayflow.db`；不做 EpochToDo 历史数据导入。

## 4. 用户已定的部分（照用户说的写）

- **范围**：完整功能获取 + 重实现，"只要功能都对其他无所谓"（2026-10-25 对话原话）。
- **实现自由度**：技术栈、代码组织、视觉表现全部由建造者决定；功能正确性是唯一硬标准。
- **开发方式**：superpowers 工作流（brainstorming → writing-plans → 执行），工作在 `feat/epochtodo-integration` 分支进行。

## 5. 架构决策（均为建造者/助手的决定，非用户指定）

### A. 任务与时间轴的双概念并存（不强行合并）

Dayflow 已有 `task_activities`（手动计时工作段：起止时间/标题/备注/项目/计费），EpochToDo 的"任务"是带状态机的待办树（嵌套/优先级/归档）。二者语义不同，**并存为两个实体**：

- EpochToDo 任务树 → 新表 `tasks`（parent_id、status、bang、side_focus 等），是新"专注"模块的主数据；
- `task_activities` 原样保留，Dayflow 现有计时/账单行为不动。
- 两者的"项目"统一指向 Dayflow 项目树（`projects` 表）：EpochToDo 完成任务时的强制选项目、项目归档等行为在 Dayflow 项目树上实现；EpochToDo 项目若有 Dayflow 缺的字段，扩展 `projects` 表补足。

### B. 时间轴呈现

EpochToDo 的"专注会话历史"作为 Dayflow 时间轴上的**独立泳道/图层**（数据源 = 专注会话，不参与活动段 LLM 归类），保留其"一天专注史"视图功能；活动时间轴 LOD 与几何规则不动。

### C. 技术栈重映射表

| EpochToDo | 合并后 | 说明 |
|---|---|---|
| better-sqlite3 + kysely | sql.js（`db.ts` 封装） | SQL 服务层重写为纯 SQL 模块，事务用显式 BEGIN/COMMIT |
| active-win | koffi FFI（`foreground.ts`） | 挂起坑，一律替换 |
| Tailwind + clsx + tailwind-merge | dayflow 设计令牌 CSS | 组件按暖色主题重绘 |
| zustand | React 内建 state/context | 跨窗口状态走主进程广播（本来就是），不引入新状态库 |
| lucide-react | Dayflow 现有图标做法（内联 SVG） | 跟随现有 components 惯例 |
| vite-plugin-electron + electron 30 | electron-vite + electron 45 | 两套 preload/IPC 合并进 `window.dayflow.*` |
| vitest（137 用例） | vitest（引入为 devDep） | 语义等价移植：mdSync pure、命令解析、AI 路由、优先级、计时状态机 |

### D. 窗口与全局交互

- **Spotlight**：全局热键 `Alt+Space`（globalShortcut），独立无边框窗口；命令文法、时间解析（`30m/1h/45s`）、Tab/Shift+Tab 缩进保持输入焦点、右键菜单、Quick Countdown Picker 原语义重实现。
- **Overlay**：置顶透明工具窗，显示当前焦点/副焦点行/等待倒计时/训练卡/AI 软提醒卡行；呼吸光晕 + 跑马灯动画（各自开关/强度/速度，设置页实时预览）；保存 bounds 经多显示器校验（v1.4.2 语义）。
- **Reminder**：硬提醒（到期 nagging、review 类）独立小窗，与 Dayflow 学习监督的 `InterruptOverlay` 并存但 UI 组件可复用。
- 与托盘/菜单共存：Dayflow `tray.ts`、`menu.ts` 扩展，不替换。

### E. 时钟与计时引擎

TimerManager（focus/wait/adhoc/training 四类计时、并发规则、到期 nagging、+5min snooze、重启恢复/GPU 启动对账）作为主进程单例服务重实现，挂 `src/main/timer/`；持久化点与 EpochToDo 对齐（崩溃后重启状态可恢复）。纯逻辑部分（状态机转换、到期判定）抽成无 `db`/`fs`/`electron` 依赖的纯模块以便测试。

### F. webhook 与 AI 提醒

`src/main/server.ts`（新增）监听 62222：路由、UTF-8 解码、`kind:"ai"` status→卡片映射（info/progress/failure 软卡；needs_input/review 走硬提醒/可操作通道）、`ai-dismiss` 匹配与 `force` 语义、内存态卡片生命周期、跨窗口广播（主进程内存持有 + 推送到各窗口）——全部按语义规格逐条对齐。AI 软提醒与 Dayflow 现有 ai-memory 侧车互不干扰（不同端口）。

### G. mdSync

`src/main/mdSync/`（pure 核心 + service + autoSync）按语义规格重实现：内容 hash 匹配、subtree 移动、启动 repair、防抖参数（笔记→应用 ~2s + 3s mtime 轮询兜底；应用→笔记 ~0.5s）原样。

### H. wandb/GPU 训练卡

GraphQL 轮询 + webhook 训练更新去重规则原样；GPU 卡字段（cfg name、ETA、epoch 进度、hostname、GPU 型号、wandb 链接）与 Overlay 训练行原样。Spotlight 任务树对训练/监控任务隐藏的 decluttering 规则原样。

### H2. GPU 排程子系统（Scheduler）

独立于计时的排程功能（scheduler_gpus/scheduler_tasks/scheduler_assignments 三表 + 冲突检测：区间相交抛 `Time slot conflict detected`；assignment 生命周期与 task 状态 pending→scheduled 联动）原样重实现，落 dayflow.db 新表；UI 挂在任务/专注模块下的 GPU 排程页。语义规格 §1.2 的字段与状态枚举为准。

### H3. 跨应用分发（Dispatch）

"把任务分发到外部应用窗口"（识别前台窗 → `dispatched_target` 记忆 JSON → 剪贴板粘贴标题，last-dispatch-wins）原样重实现；识别前台窗改走 `foreground.ts` koffi FFI（替换 active-win，语义规格 §10 `task:identify-target` 的 150ms 延迟保留）。**self-dispatch guard**：分发目标是本应用自身窗口时返回 `{ok:false,error:'self-window'}` 且不记应用关联——"自身"判定用 koffi 取到的进程 PID 对比本进程，而非 active-win 的语义。

### H4. 系统设置杂项

`global_shortcut`（Spotlight 热键可改，改动即时 unregisterAll+重注册）、开机自启（auto-launch）、数据导出/导入（文件对话框；导入前自动备份旧库并返回 needsRestart）、GPU 静默时段/停滞阈值/nag 间隔等设置键沿用 settings 表键名与默认值（语义规格 §2.7/§2.8/§8）。设置 UI 并入 Dayflow 设置页新 tab，不照搬 EpochToDo 的设置布局。

### I. 测试与验收

- 引入 vitest；移植 EpochToDo 137 用例的语义为针对新实现的纯逻辑测试（mdSync merge、命令解析、AI 路由、webhook 解码、优先级聚合、计时状态机、DB 服务）。
- 逐条功能清单走查（对照本文档 §6 及两份附件规格），加上 Dayflow 原有功能的回归（typecheck + 截图自测 + mock-provider 端到端）。
- 62222 协议用 curl 序列验证（含 ai-dismiss force 路径）；mdSync 用临时目录双向用例验证。

## 6. 功能对齐基线

（待整合侦察输出——两份附件规格成为验收清单：）

- `2026-10-25-epochtodo-feature-inventory.md`：用户面功能清单（窗口/任务/计时/Spotlight/Overlay/AI 提醒/mdSync/wandb/设置/时间轴/其余）。
- `2026-10-25-epochtodo-semantics.md`：源码语义规格（数据模型/计时状态机/AI 路由/命令文法/mdSync 算法/优先级聚合/webhook 路由/窗口参数/wandb/IPC 面）。

本文档 §5 的决策与上述清单冲突时，以清单的**行为语义**为准、以本文档的**实现选型**为准。

## 7. 实施分期概要（供 writing-plans 展开）

1. **P1 数据与引擎**：schema 扩展（tasks/focus_sessions/计时/提醒）、TimerManager、纯逻辑模块 + 测试骨架（vitest 引入）。
2. **P2 协议层**：webhook 服务器（62222 全路由）、AI 提醒路由/ai-dismiss、跨窗口广播。
3. **P3 窗口层**：Spotlight → Overlay → Reminder（含全局热键、bounds 校验、动画设置）。
4. **P4 同步与集成**：mdSync、wandb/GPU 卡、GPU 排程子系统、跨应用分发、VS Code 插件验证。
5. **P5 界面收尾**：任务中心页（Dashboard 等价物）、设置页新 tab（含热键/自启/导入导出）、时间轴专注泳道、项目树整合行为。
6. **P6 验收**：功能清单逐条走查、协议 curl 验证、Dayflow 回归、测试迁移补全、AGENTS.md/文档更新。

每期结束跑 `npm run typecheck` + 相应自测；P1 起每期配纯逻辑测试。

## 8. 开放问题

（待建造者检查后填入；只保留"只有用户能回答"的问题。）
