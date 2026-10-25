# EpochToDo 完整功能清单（融合基线 → Dayflow）

> **图例**
> - 缩进 = 功能上下级从属关系
> - `⚠️ 冲突` = 与当前 Dayflow 存在概念冲突或职责重叠，冒号后为冲突内容与处理方向（决策编号见设计文档 §5）
> - 无标记 = 纯新增或无冲突，直接重实现
> - 行为精确语义（阈值/状态机/算法）以《2026-10-25-epochtodo-semantics.md》为准；文档与源码差异的取舍见附 C
> - 基线：EpochToDo v1.4.3（UI 名 FlowTask），精确行为一律以源码为准

---

## 一、任务系统

- 任务树（任意嵌套层级的父子任务）
  - 同级排序：bang 优先级降序 → sort_order 升序 → created_at 升序
  - 孤儿任务提升为根（父删除/归档时）
  - ⚠️ 冲突：Dayflow 已有"任务"（`task_activities` 手动计时工作段，关联项目/计费）——两个"任务"概念并存为两个实体，EpochToDo 任务树为主数据，`task_activities` 原样保留（决策 A）
- 任务状态机：queued / waiting / active / archived（完成 = 归档，无 done 态）
  - 专注结算回 queued；等待挂起进 waiting；完成归档整棵子树（深度上限 20）
  - 计时到期**不改**状态（供横幅/Nag 复用）
- 任务类型：standard（标准）/ reminder（软提醒、临时事务"Ad-hoc"）/ training（训练）/ notification（webhook 通知与 AI 硬提醒落库）
  - reminder：到期走软提醒（不弹窗不响铃）；取消倒计时即整个任务删除
  - training：不出现在 Spotlight 任务树/建议（declutter）；取消倒计时即删除
  - notification：创建/到期即触发 Reminder 弹窗
- 创建去重：同名未归档任务直接复用（training 除外；可跳过去重）
- 任务字段：标题、多行备注（追加式）、估计时长（分钟）、累计专注时长（秒）、标签、项目、父任务
  - 累计专注时长逐层累加到所有祖先
- next_action 标记（队列/建议列表的筛选条件；项目页可 PLAN TO NEXT 切换）
- Bang 优先级（标题任意位置 `!` 计数，`!!`/`!!!` 更高）
  - subtree-max 聚合：父任务取自身与子树最大值（只向上传播，父的 `!!` 不抬子）
  - 用于任务树/队列/Spotlight 建议排序；Overlay 队列槽位例外（只看任务自身）
- 副焦点（◎，最多 2 个）
  - 主/副焦点互斥；切换主焦点时旧焦点自动降为副（满 2 个静默跳过）
  - 把专注中任务设为副焦点：选出替补（最近专注者优先，其次最早打旗）立即上位为主焦点
  - archived/active 状态的带旗任务不占额度；超额返回 false（UI toast 提示）
- 完成任务
  - 归档自身+全部未归档后代（BFS，深度上限 20 防环）；取消其计时
  - 焦点转移：正在专注且有父 → 转到父任务并继续专注；无父 → 停止专注
  - **强制选项目**仅三个入口：Dashboard 的 Complete、Spotlight `#` 完成模式、Reminder 窗 Complete（standard 且无项目 → 先选项目再归档）
  - 不强制入口：Bullet 树 Ctrl+Enter/✓/菜单、右键菜单——直接归档
  - ⚠️ 冲突：项目来源改为 Dayflow 项目树（决策 A）
- 删除任务：递归删除整棵子树（带数量确认弹窗）；mdSync 联动删 MD 行（先删行再删库）
- 空白标题草稿清理（Bullet 树新建即建空草稿，Spotlight 关闭时自动删）
- 结构编辑（Bullet 树）：Enter 子任务 / Shift+Enter 同级 / Tab 缩进 / Shift+Tab 反缩进（sort_order 取中点插位）/ Backspace 空标题反缩进 / Ctrl+Enter 完成 / Ctrl+Backspace 删除
  - 焦点保持：结构编辑后焦点回行输入框，可持续打字
- 拖拽
  - Dashboard：拖到任务卡 = 成为其子任务并继承项目（环检测 alert）；拖到项目组 = 置根归该项目
  - 拖到外部应用 = 跨应用分发（见第十节）
- 备注追加（Spotlight `>` 命令、`任务!上下文` 写为 `Context: …`、Dashboard memo 输入框 Enter）
- 标题链接识别：URL 渲染为可点击（http/https 白名单，CJK 标点/括号边界规则）

## 二、计时系统

- 计时模型：DB `timers` 表为唯一真相源，每任务至多一行（先删后插）
  - focus=秒表（started_at 起算）；wait/training=倒计时（target_timestamp 到期时刻）
  - 显示值前端每秒本地推算；主进程无 tick 循环
- Focus 专注秒表（全局同时只开一个）
  - 开始新专注自动结算当前专注（防丢时长）；其他非 training 的 active 任务被"排他清场"降级回队列
  - 结算门槛 3 分钟：<3min 丢弃不记账不写历史；≥3min 记入累计时长 + 写历史 + 祖先累加
  - ⚠️ 冲突：与 Dayflow 自动活动追踪（2s 窗口轮询 → 活动段 → LLM 归类）是两套时间语义——专注会话不混入活动段归类，作为时间轴独立泳道（决策 B）
- Wait 等待倒计时（挂起当前工作，可多任务并行挂多个）
  - Suspend & Resume：`@25m` 一键挂起当前、切换到新任务；**挂起绝不丢时长**（先结算 focus）
  - 到期不删倒计时行、不改状态（横幅/Nag 复用）
- Ad-hoc / reminder 任务倒计时（临时事务，缺省 30 分钟）
  - 取消即整个任务删除（reminder/training 专属；有 GPU 先释放）
- Training 训练计时
  - 按 GPU 串行（GPU 被占自动暂停旧任务：释放 GPU、回队列、清 gpu_id）、跨 GPU 并行
  - 拖训练任务到 GPU 卡 → DurationInput 弹窗（默认 60 分钟）→ 启动
  - 停止弹 StopTrainingModal：已到期 = CANCEL/COMPLETE；未到期 = EARLY COMPLETE(建跟进)/BACK TO QUEUE(保留数据)/CANCEL
  - 完成自动生成跟进任务（`Process <原标题>` / `📋 Check results: <原标题>`，继承项目）
- 到期行为
  - 软路径（reminder 类）：只出过期提醒横幅（Dashboard/Spotlight/Overlay），不弹窗、不响铃、不抢焦点
  - 硬路径（standard/training/notification/GPU告警/停滞告警）：弹 Reminder 窗 + 系统通知（静音，声音由 Reminder 窗负责）
  - 非 reminder 的到期任务先进 Spotlight 的 "Tasks Ready" 内嵌弹层（Done / Skip）
  - ⚠️ 冲突：与学习监督的强打断面板（`InterruptOverlay`，feat/study-supervision）同为"打断用户"浮层——弹窗/打断通道需统一设计（决策 D）
- Nagging 追命提醒：逾期后每 15 分钟重放一次提醒（间隔 1–1440 分钟可配置），直到被处理
- Snooze 贪睡（v1.1 Universal：对所有任务类型生效）
  - Reminder 窗 `+5min`/`+30min` 按钮；Esc = training 负时（默认 15 分钟）/ 其余关闭
  - 软提醒"再提醒"弹窗：+5m/+20m/+40m 快捷 + 自由输入（`30m/1h/45s`，缺省单位分钟）
- Quick Countdown Picker（Bullet 树行内 Timer 按钮，有倒计时高亮琥珀）
  - 顶部剩余时间；6 预设 5m/15m/25m/45m/1h/2h（3×2）；自定义分钟；一键取消倒计时；点外关闭
- 右键菜单（任务行/训练 chip/建议行）：重新设定倒计时（+5/+20/+40 或 `30m/1h/45s`）/ 取消倒计时 / 完成任务
- 崩溃恢复与启动对账
  - 重启恢复进行中的计时；僵尸 active 训练任务 3 分钟对账归档；GPU 空闲状态修复
  - 加载时清理今天 ≤10 秒的垃圾历史记录

## 三、Spotlight 全局命令栏（Alt+Space）

- 全局热键呼出/收起（热键可改、录制式录入、重置；失败仅日志），居中到光标所在显示器
- 窗口：800×600 无边框透明置顶，skipTaskbar、不可调大小；Esc 隐藏（清理空标题草稿）
- 命令文法（前缀式；注意 `!`=专注、裸文本=仅创建，与 README 说法相反，以源码为准）
  - `>备注` 追加备注到当前专注任务
  - `+标题@时间` 创建软提醒（缺省 30 分钟）
  - `%标题` 创建训练任务（`` `GPU名` `` 指定 GPU）
  - `#查询` 搜索并完成任务（完成模式）
  - `!标题` 创建/切换专注
  - `标题`（无前缀）创建任务入队（不启动专注）；带时间自动升级为软提醒
  - `@25m` 单独成句 = 挂起当前（SUSPEND）；无专注任务时建"提醒"任务并挂倒计时
  - 时间表达式 `@90m / @1h / @45s`（缺省单位 = 分钟；仅整数+单字母单位）
  - 子任务语法 `主标题 : 父任务搜索词`（`子:` 挂当前专注任务下，当前是子则建同级；`子:父搜索` 用建议项为父；均继承项目）
  - 项目 `$项目名`（模糊 includes 匹配）；GPU `` `GPU名` ``（CREATE/FOCUS 带 GPU 自动升级 TRAINING）
  - `标题!上下文` → 写备忘 `Context: 上下文`
- 任务树 Bullet 编辑器（详见第一节结构编辑）
  - 行结构：折叠三角、▶ 专注、◎ 副焦点、项目色点、内联标题编辑、⏳ 等待标记、派发徽标、hover 操作（Timer/✓/🗑/⋯）
  - 训练/GPU 监控任务从任务树与建议中隐藏（decluttering）
  - GPU 选择模式（`%` 无 GPU 时）：列表显示忙闲标记、Ctrl+1..9 快捷
- 建议列表
  - 过滤：非归档、排除 reminder/training；标题含查询词或项目名匹配
  - 排序：子树 bang 优先级稳定排序（平手保持创建时间倒序）；空输入显示 next_action 队列前 10
  - ↑↓ 循环高亮、Ctrl+1..9 直选、Enter 执行、Esc 关闭、点击 = 专注
- Active 区：当前专注卡（项目色条、秒表）+ waiting 标准任务行（倒计时，点击 = 恢复专注，右键菜单）
- Training 行：waiting 训练 chip 前 3 条（点击 = 取消倒计时，右键菜单）
- 过期提醒横幅（琥珀）：再提醒/开始专注/✓ 完成
- AI 提醒卡片行（青）：状态徽标、来源·标题、外链点击、🔔 转软提醒、✓ 忽略、相对时间
- Tasks Ready 内嵌弹层：非 reminder 到期任务列表（Done / Skip and continue）
- 完成确认弹层（无项目 standard → Select Project & Complete：↑↓/Ctrl+1..9/Enter/Esc）
- Footer：命令速查行 + 快捷键提示
  - ⚠️ 冲突：无——Dayflow 无对应物，纯新增

## 四、悬浮 Overlay（置顶透明窗）

- 显示内容（自上而下）
  - Focus 行：图标 + 父链面包屑（最多 5 层，静态模式只显示完整放得下的层级）+ 标题 + 计时
  - 副 Focus 行（最多 2 条）：独立辉光/跑马灯开关
  - Suspended 行：waiting 标准任务最多 3 条（倒计时）
  - Queued 行：queued 标准任务最多 3 条（自身 bang 数 → 最近专注排序）
  - 提醒行（琥珀）：未过期 reminder 最多 3 条
  - AI 提醒行（青）：内存 AI 卡最多 2 条
  - 训练行（绿）：最近 3 个训练，cfg 名 + 预计结束时间（`MM/DD HH:mm`）或 `ETA: …`（不显示 hostname）
  - 过期提醒行（底部玫红）：过期软提醒最多 3 条，呼吸闪烁
- 动效（设置页实时预览）
  - 焦点标题呼吸辉光（仅文字）：开关/强度（2–14px）/周期（1–6s）；副焦点独立开关
  - 长标题跑马灯（单份无缝循环）：开关/速度（10–100px/s）；副焦点独立开关
- 计时显示规则：倒计时优先（≤-2s 显示 DONE、≤0 显示 00:00，d/h/m 分段格式）；其次秒表（累计+进行中）
- 外观设置：不透明度（10–100%）、字号（10–24px）、文字颜色（6 色盘）
- 窗口行为
  - 透明、置顶（screen-saver 级）、不可聚焦、skipTaskbar、默认鼠标穿透（可切换为可拖拽+半透明底）
  - 多显示器 bounds 校验（加载/保存双保险，防错误尺寸被记忆）
  - 尺寸/位置记忆（1s 防抖保存 + 启动 5s 宽限期不保存）
  - 置顶每 30 秒重申；托盘"Re-assert Overlay Topmost"手动补救；重置位置 = 主屏居中
- ⚠️ 冲突：Dayflow 学习监督已有强打断浮层（InterruptOverlay）——同为浮层但职责不同（被动展示 vs 强打断），并存；视觉层级/样式需统一（决策 D）

## 五、Reminder 弹窗（硬提醒）

- 弹窗 + 音效（C5-E5-G5 三音琶音，之后每 5 秒循环直到清空）+ 任务栏闪烁 + 全桌面置顶
- 内容：当前提醒大卡（按类型着色：训练完成/GPU 空闲/系统通知/任务就绪/提醒）+ `Other Pending (n)` 列表（点击 = 完成）
- 按钮与键盘
  - Enter = 完成/确认（training 走停止流程；gpu-idle/notification 仅关闭）
  - Esc = training 负时（默认 15 分钟）/ 其余关闭
  - `+5min` / `+30min` 贪睡；`Continue` = 开始专注（training 无）
- standard 且无项目 → 内嵌 Assign Project 页（选项目 = 设项目+归档）
- 排序：standard 排末尾作为"当前"优先展示；空列表自动隐藏
- ⚠️ 冲突：与学习监督强打断面板的"提醒/打断"职责重叠（同上，决策 D）

## 六、AI 软提醒与 Webhook（端口 62222）

- `POST /hook` 外部集成协议（工具/agent 统一入口；源码实际绑 `0.0.0.0`，本机建议 127.0.0.1 访问；无鉴权）
  - `kind:"ai"` AI 提醒：`source`+`title` 必填（否则 400）；`status` 白名单 success/failure/needs_input/review/progress，未知归 info；`detail/link/timestamp`（秒或毫秒自动识别）
  - status 路由：`success/needs_input/review` → 硬提醒（落库 `🤖 来源 · 标题` notification 任务 + 弹窗 + 铃，可继续专注/完成）；`failure/progress/info` → 软卡（纯内存，不落库，重启清空）
  - `kind:"ai-dismiss"` 撤回：source/title 至少给一个；精确匹配 `🤖` 任务递归删除（删除不看 force）；force 控制渲染端是否连 needs_input/review 行动卡一起清；已弹出的 Reminder 窗同步隐藏；响应 `{success, dismissed_tasks}`
  - 同回复多条（source+title 相同）：转软提醒/忽略会连带清同回复的信息卡，行动卡（needs_input/review）保留（force 全清）
  - 通用通知 `{title, message}`（无 kind）→ 合成 notification 伪任务 → 弹窗 + 铃
  - 训练状态更新（含 `model_name/gpu_name/eta/metrics/task_id` 判定）→ 任务解析四级优先 → GPU 自动建卡；`metrics.status==='completed'` 归档+建跟进任务；找不到任务 404
  - UTF-8 整包解码（防多字节跨包乱码）；CORS；端口占用打印警告
- Promote（🔔 转为软提醒）：建 reminder 任务 + 插已过期倒计时 → 进过期提醒横幅（不弹窗不响铃）
- AI 卡片管理
  - 各窗口独立卡片行（上限 20，新→旧）；状态色标（✓绿/✕玫/!琥/?紫/⋯青/i青）+ 相对时间
  - 跨窗口即时同步（Dashboard/Spotlight/Overlay）；任一窗口操作广播回所有窗口
- 桌面宠物桥（`GET/POST /bridge/*`）
  - `GET /bridge/state`：focus/sideFocus[]/queued[](≤20)/dueReminders[](≤10)，任务形状含 priority
  - `GET /bridge/reminders`：一次性领取（announced 去重，重启不重复），硬软两路都进 feed（≤100）
  - `POST /bridge/tasks`：建顶层 standard 任务（同名去重），成功触发 MD 导出
- opencode 插件自动上报（session.idle）+ `notify_agent.sh` 手动脚本
- ⚠️ 冲突：Dayflow 已有自己的 AI 通道（ai-memory 侧车、导师 Agent 对话）——两套"AI 对用户说话"体系并存，提醒/卡片语义需统一设计（决策 F）；端口不同（62222 vs AI_MEMORY_BIND）无占用冲突
- ⚠️ 冲突：外部协议是硬约束（payload 形状不可改）——与"重实现自由"抵触处以协议为准（约束 §3.4）

## 七、mdSync 双向同步

- `epochtodo.md` checkbox bullet 格式（`- [ ]`/`- [x]`，bullet 符 `-`/`*`/`+` 均可；2 空格或 1 Tab 一层）
- 非复选框行（笔记/标题）原样保留永不改动；匹配键 = md5(trim(行)) 前 16 位 hex
- 笔记 → 应用
  - 新 bullet = 新任务；改行 = 改名（MD 侧获胜）；勾选 `[x]` = 删除活动任务（不从 `[x]` 建任务，子级上提继续同步）；删行 = 删除任务（hash 消失即删；空标题草稿豁免）
  - 目录级文件监听（抗 Windows 原子保存）+ 3s mtime 轮询兜底；防抖 2s（自身写文件抑制窗口 1.5s）
- 应用 → 笔记
  - 新任务插入父子弹群末尾（孤儿子任务）/ 末尾追加（全新树）；改名就地重写该行；完成打 `[x]`
  - 层级变更 = 子树手术式搬移（含注记行，保留相对缩进；防 watcher 用旧缩进改回）
  - 删除 = 删对应行（hash 优先、标题 hash 兜底）；防抖 0.5s；写前内容预览比对跳过无变化
  - `[x]` 行永不删除（用户自行清理）
- 双向冲突规则：watcher 同步只 MD→DB 单向不回写（regenerateMd=false）；手动同步才双向回写
- 启动/同步自愈：僵尸 active、缺失 next_action、归档但 MD 未勾选 → 恢复、parent_id 与缩进树不符、标题不一致（MD 获胜）
- 设置 UI（Settings → MD 同步）
  - 启用开关、选择文件夹、路径显示；启用前重名检查（列出重复确认后导入）
  - 状态区：同步指示、上次同步时间、错误横幅、只读预览文件；每 3s 轮询
- 导入（查重/强制导入，checked 跳过子级上提）、导出（整树生成）
- ⚠️ 冲突：无——Dayflow 无对应功能；与 Dayflow 的 Ctrl+E 报告导出不同层次，共存

## 八、wandb / GPU 训练监控

- wandb 自动检测（GraphQL，30s 轮询，最近 5 项目 × 50 runs 筛 running）
  - 配置：Entity + API Key（onBlur 持久化重启轮询）；测试连接（项目数 + hostname）
  - 自动建卡建任务：run → training 任务（is_webhook=1）+ GPU 卡（host_id=`wandb:{project}:{runId}`）+ 绑定 busy
  - run 消失查最终态（查不到 = 瞬时错误继续跟踪，防误归档）；正常结束 → 删卡归档；crashed/killed → 标停滞转告警
  - 幽灵卡清理（每轮 + 启动 cleanupWandbGpus）
- GPU 卡（Dashboard 右栏）
  - 卡头 cfg 名（metrics.cfgname 回退 GPU 名）；状态点（busy 绿/idle 灰/stalled 红）
  - wandb 卡：`ETA: x.xh → MM/DD HH:mm` + wandb 外链、`hostname · GPU 型号`、`Epoch a/b · iter c/d`
  - webhook/手动卡：模型名（webhook 带 🔒）、ETA 字符串或倒计时、✕ 弹停止弹窗；webhook 卡虚线蓝边禁拖入
  - 空闲卡：`Idle: Xm/Xh`（last_active_at 起算，缺失自动修复）
  - 拖 training 任务到卡 = 分配并启动（DurationInput）
- webhook 训练更新 + 去重（任一 wandb 条目在跑时整体压制 webhook 通道；单任务来源为 wandb 也不被覆盖）
- GPU 健康检查（每 60 秒）
  - 免打扰时段默认 23:00–8:00（支持跨零点，时段内全静默）
  - 训练停滞告警：5 分钟无更新判停滞（阈值 1–120 可配），每 10 分钟重发硬提醒（`⚠️ 训练停滞: <模型名>`），恢复解除
  - GPU 空闲告警：有排队训练任务且有空闲 GPU → 节流 15 分钟发合成硬提醒（列排队任务与空闲 GPU）
- 启动对账：3 分钟宽限后归档无遥测的 active 训练、释放 GPU、立即体检
- ⚠️ 冲突：无——Dayflow 无 GPU 概念，纯新增

## 九、GPU 排程子系统（Scheduler，独立页）

- 与任务系统完全独立的数据：排程 GPU / 排程任务（标题+预估工时，支持 `2d5h`/`3d`/`10h`/纯数字=小时）/ 时段分配
- GPU 行 + 按天时间轴（hourWidth 缩放）；拖任务建排程块
- 时段区间冲突检测（相交 → `Time slot conflict detected` 报错）
- 分配/删除与任务状态 pending ↔ scheduled 联动；Clear All 全部回 pending
- ⚠️ 冲突：无——纯新增

## 十、跨应用分发（Dispatch）

- Bullet 行拖出：标题写入 `text/plain` + 剪贴板 → 150ms 等 OS 切前台 → 识别前台窗口
- self-dispatch guard：目标是本应用自身 → 拒绝（不记关联、不粘贴），含树内拖拽
- 否则记录 `dispatched_target`（{进程名, 窗口标题, 可执行路径, 时间戳}，last dispatch wins）→ 模拟 Ctrl+V 粘贴标题（仅 Windows）
- 派发徽标：行内 `📤 进程名` chip（悬停看窗口标题+时间）
- ⚠️ 冲突：实现层——EpochToDo 用 active-win（Electron 主进程永久挂起），必须换 Dayflow 的 koffi FFI，"自身进程"判定改用 PID 对比（决策 H3）；功能与 Dayflow 无冲突

## 十一、时间轴（专注会话史，Dashboard 左栏）

- 288px 宽；日期导航（←/→ 按天）；24 小时网格（每小时 60px）
- 今天显示当前时间红线（带光晕，每分钟更新）
- 会话块：历史记录按起止定位，高度按时长（最小 22px），靛蓝色块 + 标题 + 时长
  - 重叠会话自动分 lane（同簇多 lane 均分宽度）；hover ✕ 删除（确认）
  - ≤3 分钟会话不显示（对应结算丢弃）；底栏当日 Focus 总计
- ⚠️ 冲突：与 Dayflow 时间轴（自动追踪活动段 + LOD + LLM 归类）直接撞概念——专注会话作为时间轴独立泳道/图层，不参与归类（决策 B）
- 源码标注 deprecated 待重构——重实现即按泳道方案重构（决策 B）

## 十二、项目管理

- 项目 CRUD（名称/描述/颜色，8 预设色）；删除项目 = 任务 project_id 置空（弹确认）
- 项目工作区三列看板
  - Backlog：Capture 输入框建任务；Next Actions 子区（PLAN TO NEXT 切换）；递归树（START NOW 开始专注）；拖拽排序
  - In Active Focus：active/waiting 卡（点击恢复专注；focus 卡脉动高亮）
  - Archive：归档列表（灰度划线，含日期与时长）
- 项目统计：任务数、专注总时长；`Switch & Focus`（聚焦该项目最近做过/第一条）
- 完成任务强制选项目（见第一节）
- ⚠️ 冲突：Dayflow 项目树是规则引擎/自动归类/项目合并的载体（职责完全不同）——统一为 Dayflow 项目树，EpochToDo 所需字段扩展 `projects` 表（决策 A）

## 十三、Dashboard 主界面（融合后不独立存在）

- 布局：左侧图标栏（Dashboard/Projects/GPU Scheduler/Settings）+ 左时间轴 + 中央工作区 + 右栏（可拖宽 250–600px，记忆）
- Current Focus 卡：斜纹动画进度条、项目 chip、`Subtask of <父>`、大号秒表、Complete 按钮、memo 输入框
- Paused/Waiting 网格：waiting 标准任务卡（项目色条 + 倒计时，点击 = 恢复专注）
- 过期提醒卡（软）：再提醒/▶/✓ 三按钮
- Next Actions：按项目分组（Inbox 置顶），组头 Switch & Focus；行 = 把手/色条/标题/已计时/tag/hover 操作（Start/Complete/Delete/Edit）
- 右栏：GPUs 区（+ 新建、拖入分配、webhook 卡禁拖）/ AI Reminders 区（青）/ 提醒区（reminder 倒计时，✕ = 取消）
- 弹窗：Assign Project、删除确认、CreateGpu、DurationInput、StopTraining、Snooze
- ⚠️ 冲突：Dayflow 主窗口是三栏壳（侧边栏/主区/常驻时间轴）——不做独立 Dashboard 窗，功能拆入 Dayflow 导航（新增"专注/任务"页，复用组件）；视觉按 Dayflow 暖色设计令牌重绘（决策 D）

## 十四、设置（5 个 tab）

- 通用：Spotlight 激活键（录制式录入、重置 Alt+Space）；通用任务提醒间隔（1–1440 分钟，默认 15）；开机自启
- GPU 与训练：空闲提醒间隔（1–120，默认 15）；免打扰时段（0–23，默认 23→8）；停滞阈值/提醒间隔（1–120，默认 5/10）；wandb Entity/API Key + 测试连接
- 悬浮窗：鼠标穿透开关 + 重置位置；不透明度/字号/文字颜色；辉光与跑马灯开关/强度/速度 + 实时预览
- MD 同步：见第七节
- 数据：主题（锁定深色）；导出/导入 .db（导入前自动备份，需重启）；清空数据库（严格确认：输入 `strict`）
- ⚠️ 冲突：Dayflow 已有设置页——合并为设置页新 tab，不照搬 EpochToDo 设置布局（决策 H4）

## 十五、系统与外部集成

- 托盘：单击打开主面板、Re-assert Overlay Topmost、退出
  - ⚠️ 冲突：Dayflow 已有托盘（tray.ts）——托盘菜单合并为一个
- 关闭按钮 = 隐藏后台（Quit 才真退出）；单实例锁 / 数据目录环境变量（对应 DAYFLOW_USER_DATA 机制，无冲突）
- VS Code 调试通知插件
  - 调试结束通知；**断点暂停通知**（README 宣传但源码未接线——重实现补上，见附 C）
  - 终端命令完成通知（Shell Integration；成功/失败/命令过滤正则/忽略正则默认 `^zellij`）
  - 后台暂停提醒：调试暂停且 VS Code 失焦每 5 分钟提醒
  - 配置：webhook URL、忽略单步事件、聚焦时静默等
  - ⚠️ 冲突：无——webhook 兼容即可零改动使用

---

## 附 A：与 Dayflow 冲突总表

| # | 冲突点 | 性质 | 处理方向 |
|---|---|---|---|
| 1 | "任务"概念：任务树 vs `task_activities` 手动计时段 | 概念撞车 | 双实体并存，任务树为主数据（决策 A） |
| 2 | "项目"体系：任务项目 vs 规则引擎项目树 | 概念撞车 | 统一到 Dayflow 项目树（决策 A） |
| 3 | 时间轴：专注会话史 vs 自动活动段 | 概念撞车 | 独立泳道/图层（决策 B） |
| 4 | 打断/提醒浮层：Reminder 窗+Overlay vs 学习监督强打断 | 职责重叠 | 打断通道统一、视觉统一（决策 D） |
| 5 | AI 对用户说话：webhook 提醒卡 vs ai-memory/导师 Agent | 职责重叠 | 提醒语义统一设计，端口并存（决策 F） |
| 6 | 主界面：Dashboard vs Dayflow 三栏壳 | 布局冲突 | 功能拆入 Dayflow 导航，不另开主窗（决策 D） |
| 7 | 设置页 / 托盘 | 重复载体 | 合并为设置 tab / 统一托盘（决策 H4） |
| 8 | active-win 前台识别（Electron 主进程挂起） | 实现冲突 | 换 koffi FFI + PID 判自身（决策 H3） |
| 9 | better-sqlite3 + kysely（需原生编译） | 实现冲突 | 重写到 sql.js（约束 §3.1） |
| 10 | 外部协议（62222 / mdSync / VS Code 插件）vs 重实现自由 | 约束抵触 | 协议逐字节兼容优先（约束 §3.4） |

## 附 B：Dayflow 现有功能基线（全部保留，不得退化）

- 前台窗口追踪（2s 轮询，活动段实时落库）+ 锁屏/睡眠暂停
- 多屏截图（30s 采样，LLM 视觉佐证）
- 规则引擎（递归谓词树 all/any/not/cond，新建规则回溯历史）
- LLM 归类（app 级 + 浏览器页面级，节流；手动分类记忆）
- 浏览器历史 → 页面标题转 URL
- 项目树（规则、统计、拖拽归类 + Alt 建规则、项目合并）
- 时间轴 LOD（band 合并、按比例几何、悬停浮窗）
- 整理（Review）/ 每日站会 / 每周回顾 / 对话查询
- 手动计时任务（`task_activities`，计费标记）
- 数据导出（Ctrl+E）、应用图标提取、中文菜单栏、托盘、设置页
- 学习监督与导师 Agent（feat/study-supervision 开发中：监督引擎、强打断面板、导师设置 tab）
- ai-memory 侧车集成（对话/记忆）

## 附 C：文档 vs 源码差异的取舍（均为我的决定，非用户指定）

| # | 差异 | 取舍 |
|---|---|---|
| 1 | README/TERMINOLOGY 把命令前缀 `!` 与裸文本写反 | 以源码为准：`!`=切换专注、裸文本=仅创建入队 |
| 2 | 术语表有 `ad-hoc`/`external` 类型，实际不存在 | 以源码为准：ad-hoc=`reminder` 类型；AI 硬提醒=`notification` 类型 |
| 3 | "完成强制选项目"文档未说清范围 | 以源码为准：仅 Dashboard/Spotlight `#`/Reminder 窗三入口；Bullet 树与右键直接归档 |
| 4 | Spotlight footer "Total Focus Today" 恒为 0 的占位符 | 实现真实统计（占位属缺陷，非功能） |
| 5 | 任务行 ✎ 编辑按钮是 TODO 占位 | 不做独立按钮；改名经 Bullet 树内联编辑（功能等价） |
| 6 | VS Code 插件"Debug Paused"监听未接线（防抖器在） | 补上 `onDidStopDebugSession` 接线——README 宣传的功能应当存在 |
| 7 | hook 服务实际绑 `0.0.0.0`（文档写 127.0.0.1） | 保持 `0.0.0.0` 与源码行为一致（功能对齐优先；文档继续建议本机 127.0.0.1 访问） |
| 8 | 时间轴源码标注 deprecated 待重构 | 保留功能，按决策 B（泳道方案）重构呈现 |
