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
- [ ] 合入 `src/main/todo/mdsync/*`（子代理产出，核对语义规格 §5 后提交）
- [ ] `wiring.ts`：mdSync 配置读取（`md-sync-enabled`/`md-sync-folder` 并入 TodoSettings）+ AutoSyncManager 生命周期（start/stop、broadcastFetchTasks 联动 triggerExport）
- [ ] registry+preload：`md-sync:select-folder`（目录对话框）/`md-sync:check-file`/`md-sync:import`/`md-sync:export`/`md-sync:sync`/`md-sync:check-duplicates`/`md-sync:read-file`/`md-sync:set-config`/`md-sync:get-status`
- [ ] 设置页 MD 同步区（启用开关/目录/状态/预览）
- [ ] 测试回归 + commit

### 任务 2：wandb 桥接线
- [ ] 合入 `src/main/todo/wandb/*`（子代理产出，核对语义规格 §9）
- [ ] `wandb-bridge.ts`：设置齐备才启动轮询（restart 语义）、active run → GPU 卡/训练任务绑定、finished → 归档删卡、crashed/killed → 停滞、每轮清理幽灵卡、喂 `trainingStatus`（source='wandb'）
- [ ] wiring 生命周期 + `wandb:test` IPC
- [ ] 测试回归 + commit

### 任务 3：全量验收走查（对照功能清单 §一–§十五 + 附 D）
- [ ] 每节逐条打勾（功能存在 + 关键语义有测试/冒烟证据），输出验收表
- [ ] 不达标项修复或记录
- [ ] `npm test` + `typecheck` + `build` + 四窗冒烟（主窗/任务页/Spotlight/Overlay）+ Reminder 触发冒烟（webhook 发硬提醒）
- [ ] 62222 协议 curl 抽查（kind:ai / ai-dismiss / 训练更新 / 通知）

### 任务 4：文档与记忆收尾
- [ ] AGENTS.md 现状改"全部完成"；计划勾选；项目记忆更新
- [ ] 最终 commit + 总结报告
