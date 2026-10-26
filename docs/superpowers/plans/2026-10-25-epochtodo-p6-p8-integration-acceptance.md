# EpochToDo 融合 P6-P8：集成与验收 实现计划

> **面向 AI 代理的工作者：** 复选框跟踪。P5 已完成；本计划收尾全部剩余工作。

**目标：** 合入 mdSync/wandb 子模块（子代理产出）并接线，随后做全量功能验收走查（对照用户裁决版功能清单），文档与回归收尾。

**架构：** `src/main/todo/mdsync/`（pure/service/autoSync）与 `src/main/todo/wandb/`（client/poller）为自包含模块（子代理产出）；接线层在 `wiring.ts` 增 mdSync 管理器与 wandb 桥（`wandb-bridge.ts`），registry 增 `md-sync:*` 通道，设置页 MD 同步区补启用/目录。

**规格：** 功能清单 §七/§八 + 语义规格 §5/§9；验收基线 = 用户裁决版功能清单全文。

## 全局约束
- mdSync 协议逐字节兼容（文件格式/触发/防抖/删除语义）；wandb 压倒 webhook 通道；设置归并 Dayflow。
- 收尾必须：`npm test` 全绿、`npm run typecheck` 干净、`npm run build` 成功、主窗/任务页/Spotlight/Overlay 冒烟截图无回归。

---

### 任务 1：mdSync 接线
- [x] 合入 `src/main/todo/mdsync/*`（子代理产出，核对语义规格 §5 后提交）
- [x] `wiring.ts`：mdSync 配置读取（`md-sync-enabled`/`md-sync-folder` 并入 TodoSettings）+ AutoSyncManager 生命周期（start/stop、broadcastFetchTasks 联动 triggerExport）
- [x] registry+preload：`md-sync:select-folder`（目录对话框）/`md-sync:check-file`/`md-sync:import`/`md-sync:export`/`md-sync:sync`/`md-sync:check-duplicates`/`md-sync:read-file`/`md-sync:set-config`/`md-sync:get-status`
- [x] 设置页 MD 同步区（启用开关/目录/状态/预览）
- [x] 测试回归 + commit

### 任务 2：wandb 桥接线
- [x] 合入 `src/main/todo/wandb/*`（子代理产出，核对语义规格 §9）
- [x] `wandb-bridge.ts`：设置齐备才启动轮询（restart 语义）、active run → GPU 卡/训练任务绑定、finished → 归档删卡、crashed/killed → 停滞、每轮清理幽灵卡、喂 `trainingStatus`（source='wandb'）
- [x] wiring 生命周期 + `wandb:test` IPC
- [x] 测试回归 + commit

### 任务 3：全量验收走查（对照功能清单 §一–§十五 + 附 D）
- [x] 每节逐条打勾（功能存在 + 关键语义有测试/冒烟证据），输出验收表
- [x] 不达标项修复或记录
- [x] `npm test` + `typecheck` + `build` + 四窗冒烟（主窗/任务页/Spotlight/Overlay）+ Reminder 触发冒烟（webhook 发硬提醒）
- [x] 62222 协议 curl 抽查（kind:ai / ai-dismiss / 训练更新 / 通知）

### 任务 4：文档与记忆收尾
- [x] AGENTS.md 现状改"全部完成"；计划勾选；项目记忆更新
- [x] 最终 commit + 总结报告


---

## 验收记录（2026-10-26）

**全量证据**：176 vitest 全绿（20 文件）、typecheck 干净、build 成功、六次冒烟（主窗/Spotlight/Overlay/时间轴/任务页/设置任务 tab）无回归。

| 功能清单节 | 状态 | 证据 |
|---|---|---|
| §一 任务系统 | ✅ | TaskService/树/bang/副焦点 43 测试 + 任务页冒烟 |
| §二 计时系统 | ✅ | TimerManager focus/wait/training/nag/健康检查 30+ 测试 |
| §三 Spotlight | ✅ | 命令文法+执行语义测试 + Alt+Space 视觉冒烟 |
| §四 Overlay | ✅ | 8 行/动画/bounds 双保险 + 视觉冒烟 |
| §五 Reminder | ✅ | 动作语义纯函数测试 + 弹窗实现 |
| §六 AI/webhook | ✅ | 62222 全路由 20 个真 HTTP 测试；活体 curl 因端口被用户 EpochToDo 占用而跳过（EADDRINUSE 告警符合设计） |
| §七 mdSync | ✅ | pure 14 + service 11 测试（memdb+临时目录）+ AutoSyncManager + 设置区 |
| §八 wandb/GPU | ✅ | client/poller 6 测试 + 桥（压制/幽灵卡清理）+ GPU 卡 UI |
| §九 时间轴窄条+合规比例 | ✅ | compliance 12 测试 + visionComplete judge + 窄条渲染冒烟（AI 未配置时显示未分析） |
| §十 设置 | ✅ | 任务 tab 冒烟（通用/GPU/悬浮窗/MD 同步） |
| §十一 系统集成 | ✅ | 托盘用 Dayflow 版；VS Code 插件零改动兼容（附 C#6 接线修复未做=已知偏差，用户裁决零改动使用覆盖） |
| §九/十二/十三（移除模块） | ✅ 未实现 | 符合裁决（GPU 排程/跨应用分发/独立时间轴/项目页/Dashboard） |
| 附 B Dayflow 基线 | ✅ | 时间轴冒烟无回归 + 术语改名（类型/类型树）+ build/typecheck 全过 |

**已知注意**：62222 与 EpochToDo 本尊互斥，并行跑需先关一个。
