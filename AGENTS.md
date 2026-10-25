# AGENTS.md — Dayflow for Windows

> 本文件是本仓库的主文档（面向人与 AI 协作）。改代码前先读这里；改完该更新的也在这里。

macOS 自动工作日志 [JerryZLiu/Dayflow](https://github.com/JerryZLiu/Dayflow) 的 Windows 完整移植。
应用每 2 秒记录前台窗口标题（行为判定的**主要**依据），配合多屏截图（默认 30s，**补充**证据），
经规则引擎 + LLM 自动归类到项目树，生成时间线 / 每日站会 / 每周回顾 / 对话查询。

## 常用命令

```bash
npm run dev         # 开发（electron-vite dev）
npm run typecheck   # tsc node + web 两套 tsconfig，提交前必跑
npm run build       # 构建 main/preload/renderer 到 out/
npm run dist        # build + electron-builder（NSIS win-x64）
```

- 打包输出在 `release-build/`（**不是** `dist/`，见下方 EBUSY 坑），安装包复制到 `release/Dayflow-Setup-1.0.0.exe`。
- 直接运行打包产物：`release-build/win-unpacked/Dayflow.exe`。
- 依赖只有 `koffi`（FFI）与 `sql.js`（WASM SQLite）两个运行时依赖，**禁止引入需要原生编译的依赖**
  （机器上没有 VS Build Tools，`npmRebuild: false` 固定在 electron-builder.yml）。

## 目录结构

```
src/
  main/            # Electron 主进程
    index.ts       # 窗口/托盘/自测截图钩子
    windows-poll.ts# 2s 前台窗口轮询 → app_activities 段（核心追踪）
    foreground.ts  # koffi FFI 取前台窗口（勿用 active-win，见坑#1）
    capture.ts     # 多屏截图（BGRA 拼接全景）
    projects.ts    # 项目树 + 规则引擎 + 归类 + 统计（最大模块）
    ai/            # providers / analyze(时间线) / llm-classify / group / standup / chat
    browser-history.ts # Chrome/Edge/Firefox/Zen 历史库拷贝 → 标题转 URL
    app-icons.ts   # app.getFileIcon 提取真实应用图标（app-icons.json 缓存）
    db.ts          # sql.js 全内存 + 防抖落盘（%APPDATA%\Dayflow\data\dayflow.db）
    menu.ts        # 中文应用菜单栏（文件/编辑/视图/窗口/帮助，Ctrl+E 导出）
    ipc.ts / settings.ts / tasks.ts / weekly.ts / exporter.ts / cleanup.ts / paths.ts
    todo/          # 任务域（EpochToDo 融合）：schema/service/gpu-service/timer-manager
                   # + 纯逻辑 priority/hierarchy/commands + 设置；测试在 tests/todo/（vitest）
  preload/index.ts # contextBridge API（window.dayflow.*，类型自动流入 renderer）
  renderer/src/
    App.tsx        # Timing 式三栏壳：侧边栏(导航+项目树) | 主区 | 常驻时间轴
    pages/         # TimelinePage(=ActivitiesView) / ReviewPage / ProjectsPage /
                   # DailyPage / WeeklyPage / ChatPage / SettingsPage
    components/RuleEditor.tsx  # 嵌套规则编辑器（Review 与 Projects 共用）
    lib/           # drag.ts(拖拽归类+Alt建规则) / format.ts / markdown.tsx
    styles.css     # 全部样式（暖色主题 + 设计令牌，见下）
tools/             # mock-provider.mjs(端到端假AI) / db-set.mjs / patch-*.py
```

数据目录：`%APPDATA%\Dayflow\`（`data/dayflow.db`、`recordings/YYYY-MM-DD/*.jpg`）。

## 架构要点（改动前必读）

1. **追踪主循环**（`windows-poll.ts`）：2s 轮询前台窗口 → 相同 key 延长现有段并**每 tick 活写 DB**
   （当前块必须实时可见）；换窗口 finalize 段（<min(20s,4s) 丢弃）。输入空闲 ≠ 离开电脑——
   只在锁屏/睡眠（powerMonitor）时停止；无输入的段标 `is_idle`。
2. **归类优先级**：规则树（first-match）> 手动（classifications 表记忆）> app 级 LLM（`title_pattern='*'`）；
   **浏览器永远按页面（标题）分类，绝不按 exe**：规则 > 标题缓存 > SITE_HINTS 正则 > 节流 LLM（1次/20s）。
3. **规则是递归谓词树** `RuleNode`：`all/any/not/cond`（Timing 的 NSPredicate 等价物），
   存 JSON 于 rules 表；新规则创建即回溯（retroactive）应用到历史。
4. **AI 管线以窗口时间线为主输入**（`analyze.ts` buildWindowTimeline），≤6 张抽样截图仅作视觉佐证；
   GLM-5.x 是思考模型：zhipu 路径必须带 `thinking:{type:'disabled'}`，max_tokens 32768；
   智谱 1301 内容审核拒绝 → 跳过批次，不要重试。
5. **时间轴 LOD**（TimelinePage TimingAxis）：同项目连续段合并成 band；band<30px 不显示文字，
   ≥30px 只显示类目+时长，仅当放大且块高≥72px 才显示具体标题；悬停浮窗永远显示完整信息。
   几何必须严格按比例 `max(dur*ppm-3, 2)`——**任何 min-height 钳制都会造成重叠**（历史上踩过两次）。
6. **项目合并**（projects.ts mergeProjects）：活动/任务/规则/映射/子项目全部移入目标后软删源；
   目标是源的后代时先把目标提到源的父级，防成环。

## 任务域（EpochToDo 融合，src/main/todo/）

- **术语**："任务"专指 EpochToDo 任务树（`tasks` 表）；Dayflow 的 `task_activities` 概念改称**"类型"**、
  `projects`（规则引擎载体）改称**"类型树"**（UI/文档统一新术语，内部表名暂不动）；任务自己的项目
  在 `task_projects` 表，与类型树**互相独立**。
- **模块**：`priority.ts`（bang subtree-max）/ `hierarchy.ts`（树+祖先链）/ `commands.ts`（Spotlight 文法）/
  `service.ts`（TaskService）/ `gpu-service.ts` / `timer-manager.ts`（TimerManager：focus/wait/training、
  到期分流、nag、GPU 健康检查）/ `settings.ts`（`todo-settings` 键）/ `schema.ts`（TODO_SCHEMA_SQL）。
- **测试**：`npm test`（vitest，tests/todo/）。**新增任务域逻辑必须配纯逻辑测试**；集成面（TimerManager）
  用注入的假时钟/timeout/notify/broadcast，零 Electron 依赖。设计与语义基线见
  `docs/superpowers/specs/2026-10-25-epochtodo-*.md`（用户裁决版功能清单优先）。
- **精确语义值**（勿改）：记账门槛 180s、归档深度上限 20、副焦点 2 个、nag 默认 15 分钟、
  创建去重=精确标题（training 除外）、到期不删行不改状态、reminder 软路径不弹窗。
- **现状（P2）**：数据层、计时引擎、62222 协议层（/hook 四分支 + 桌宠桥 /bridge/* + AI 提醒软硬路由 +
  ai-dismiss + webhook 训练更新/wandb 压制）已完成并通过测试（104 例）；窗口/IPC/UI 未接线（P3 起），
  `createTodoDomain` 尚无调用方。协议兼容基线：payload 形状/状态码/错误英文串逐字节对齐源码。

## 已知坑（血泪史，勿重蹈）

1. **active-win 的 promise 在 Electron 主进程里永久挂起**（无报错、0 数据）→ 一律用 koffi FFI
   （user32 GetForegroundWindow/GetWindowTextW + psapi EnumProcesses）。
2. **打包 EBUSY**：Defender/索引器会锁 app.asar（无进程也锁）→ 输出目录用 `release-build/`，
   再复制安装包到 `release/`。
3. **残留实例持 SingletonLock**：打包版启动即静默退出；用 `tools/kill-df.ps1` 式脚本杀
   （**不要**在 bash 双引号里内联 `$_`，会被吞）。
4. **隐藏窗口彻底停帧**：遮挡检测暂停 BeginFrame，DOM 变更不被绘制、`capturePage` 抓到旧帧，
   `invalidate()` 也不够 → 截图自测钩子（DAYFLOW_SCREENSHOT）已内置先 `show()` 再截。
5. **CSS 行内元素**：`width/height` 对 `<span>`（display:inline）静默无效 —— `.app-usage-fill`
   曾因此全空；条形填充必须 `display: block`。
6. **动效填充模式必须是 `none`**：`backwards/both` 在不产帧的环境会把元素冻在 opacity:0 起始帧
   （且结束后不残留 transform，避免 fixed 定位的 `.ta-tip` 被变换祖先捕获）。
7. **`\u0000` 转义**：窗口 key 分隔符在 TS 模板串里是 `\u0000`；Python/Edit 工具匹配它需要 `\\u0000`。
8. Edit/Write 前若文件被 bash 改过，工具会报 "modified since read" —— 先 Read 再 Edit。

## 自测工具

```bash
# 截图自测（钩子会先 show 窗口恢复产帧，点导航，可注入 JS，截图后退出）
DAYFLOW_SCREENSHOT=/tmp/x.png DAYFLOW_SHOT_NAV=2 \
DAYFLOW_SHOT_JS="document.querySelector('.pm-row').click()" DAYFLOW_SHOT_WAIT=7000 \
  npx electron . --hidden

# 端到端 AI 管线（无需真实 key）
node tools/mock-provider.mjs   # OpenAI 兼容 + Anthropic 协议双协议假服务
```

`DAYFLOW_SHOT_NAV` 是侧边栏索引：0活动 1整理 2项目管理 3站会 4统计 5对话 6设置。

## UI 约定

- **视觉基因**：暖色奶油/蜜桃主题（仿原版 Dayflow），字体 LXGW WenKai（霞鹜文楷，本地 ttf）。
  全部颜色/阴影/时长/缓动都是 `:root` 设计令牌——新样式一律引用令牌，不写死值。
- **动效**：时长 `--duration-fast/normal/slow`，缓动 `--ease-out/--ease-spring`；只动
  transform/opacity/filter（不碰几何）；已全局支持 `prefers-reduced-motion` 与 `:focus-visible`。
- **交互细节**：按钮 hover 抬升 1px / active 按下 0.97；列表行 hover translateX(2px)；
  图标按钮 hover scale(1.1)；面板挂载 fade-up；页面切换 page-in。
- **语言**：全部界面文案为中文。

## 改动检查单

- [ ] `npm run typecheck` 通过
- [ ] 涉及任务域（src/main/todo/）：`npm test` 全绿
- [ ] 涉及 UI：截图自测对应页面，与既有截图对比无几何回归
- [ ] 涉及追踪/归类：跑一次真实使用或 mock-provider 端到端
- [ ] 有新坑/新决策 → 更新本文件与 AGENTS 记忆
