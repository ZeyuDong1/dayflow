# EpochToDo 融合 P5：Overlay 悬浮窗 实现计划

> **面向 AI 代理的工作者：** 复选框跟踪；视觉用 hash 注入截图自测。P6-P8 顺序见文末。

**目标：** 置顶透明 Overlay：8 行显示（Focus/副焦点/挂起/队列/提醒/AI/训练/过期）、呼吸辉光与跑马灯动画（设置实时预览）、多显示器 bounds 校验、点击穿透切换、置顶维持。

**架构：** `src/main/todo/overlay-window.ts`（窗口/bounds/穿透/30s 置顶重申）+ `src/renderer/src/OverlayWindow.tsx`（`#/overlay`）+ `TodoSettings.overlay_settings/overlay_bounds`（已并入设置模块）。

**规格：** 功能清单 §四（用户裁决版）+ 语义规格 §5.2/§5.3/§5.4。

## 全局约束

- 窗口：frameless、transparent、alwaysOnTop('screen-saver')、skipTaskbar、**focusable:false**、无阴影、默认 `setIgnoreMouseEvents(true,{forward:true})`。
- bounds 双保险：加载/保存都与真实显示器 workArea 校验，不过→回退默认 `{100,100,350,250}`；moved/resized 1s 防抖保存；**创建后 5s 宽限期内保存忽略**（DPI 启动调整）。
- 8 行与排序照功能清单 §四；队列槽位只按任务**自身** bang 数（不聚合）；行上文字用 `getTimerDisplay`。
- 动画纯 CSS（transform/opacity/filter）：辉光 `--focus-glow-radius/--focus-glow-speed`，跑马灯单份无缝循环 `--marquee-duration = cellWidth/speed`；尊重 prefers-reduced-motion（全局已有）。

## 审查重点

1. 拔显示器后错误 bounds 被持久化——保存前校验 + 宽限期双保险，纯函数 `boundsOnAnyDisplay` 可测。
2. 鼠标穿透切换后可拖拽态与显示态一致（toggle 时才 setIgnoreMouseEvents）。
3. 训练行 ETA 排序：`train/eta_hours`×3600 + lastUpdated 升序，无 eta 排最后。
4. 过期提醒行 `overlay-breathe` 呼吸与主辉光互不干扰。
5. 已销毁窗口的 30s 重申定时器不得抛错。

---

### 任务 1：纯函数 + 设置
- [x] `fitBreadcrumbLevels` 已入 `src/shared/hierarchy.ts`；`TodoSettings.overlay_*` 已入 settings（校验/回退/合并）；测试补：bounds 校验纯函数 `boundsOnAnyDisplay(bounds, displays)` 入 `src/main/todo/overlay-window.ts` 导出（纯）。

### 任务 2：overlay-window.ts
- [x] 创建/显示/隐藏、`setOverlayIgnoreMouse`、`resetOverlayPosition`（主屏居中 350×250 并持久化）、bounds 防抖保存 + 5s 宽限 + 校验、30s 置顶重申（审查重点#5 防御）。

### 任务 3：OverlayWindow.tsx + 样式 + 装配
- [x] 8 行布局、动画 CSS 变量、设置轮询/事件刷新、穿透切换按钮；wiring 启动时开 Overlay；registry `todo:set-overlay-ignore-mouse` / `todo:reset-overlay-position`；preload 通道；`#/overlay` 分流；截图自测。

### 任务 4：收尾
- [x] 全量回归、计划勾选、AGENTS.md 现状、commit。

## 执行交接
P6=mdSync/wandb 集成（子代理产出合入）→ P7=任务页/设置 tab/时间轴窄条+合规比例/术语改名 → P8=验收走查。
