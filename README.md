# Dayflow

**中文** | [English](README.en.md)

**本地优先的屏幕时间追踪 + 学习监督导师。** 自动记录你在电脑上做了什么,归类成你自己的「类型」体系;内置一位会唠叨、会反思、记得住你任务的学习导师(Agent),在你分心时按阶梯升级打断——从轻提醒一路到盖住整个窗口的强遮蔽面板。

基于 [JerryZLiu/Dayflow](https://github.com/JerryZLiu/Dayflow)(macOS)的移植(Electron),并融入了 EpochToDo 风格的任务系统。

> **当前支持 Windows 10/11**。macOS 请使用[原版 Dayflow](https://github.com/JerryZLiu/Dayflow);核心架构(Electron + React + sql.js + AI 管线)是跨平台的,移植到其他平台主要替换前台追踪/窗口几何/浏览器历史路径这几层(见 `src/main/foreground.ts`、`windows-poll.ts`、`browser-history.ts`)。

![活动页](docs/images/activities.png)

## 演示

![功能巡览](docs/images/tour.gif)

> 上图全部由**虚构合成数据**生成(管线见 `tools/demo/`,可一键复现),不含任何真实用户数据。

| | |
|---|---|
| ![任务页](docs/images/tasks.png) | ![导师对话](docs/images/chat.png) |
| **任务系统**:当前专注计时、下一步队列、GPU/AI 提醒 | **导师对话**:长期记忆 + 应用内全量上下文 |
| ![整理页](docs/images/review.png) | ![统计页](docs/images/weekly.png) |
| **整理页**:未归类批量归位、AI 预构建规则人工把关 | **统计页**:专注/分心趋势 |

## 功能

### 追踪与归类
- **窗口活动追踪**:前台窗口每 2 秒落库,AFK 时段打标不计入学习时间;截图作为辅助信号(默认 30s,可配)
- **AI 卡片**:每 15 分钟把窗口活动浓缩成可读卡片(分心也会被标出)
- **分类三层兜底**:用户规则引擎(AND/OR/NOT 任意嵌套,支持应用名/标题/**网址**)→ 学习记忆(同标题页面自动沿用)→ 站点提示;**浏览器按页面归类而非整个 exe**
- **拖拽归类**:活动树/时间轴拖到类型上即建规则;Alt+拖拽一步建「应用名+标题」规则
- **AI 整理**:未归类活动聚类成主题组,预构建成规则草稿,**人工逐条勾选确认**后才写入

### 任务系统(EpochToDo)
- 当前专注计时器、挂起等待、下一步队列(Switch & Focus)
- 番茄钟:学习攒休息余额、按比例支取、休息冷却
- 专注会话合规比例(截图判定"是否真在做该任务")
- 与 Obsidian Markdown **实时双向同步**

### 学习监督(反逃逸)
- 打断阶梯:桌面轻提醒(可延迟一次)→ **强遮蔽面板**盖住违规窗口内容区,实时跟随窗口移动,实时显示被遮页面的标题与网址
- 面板出口可配置:最小化/关闭被拦应用(浏览器只关标签页)、休息支取、"今天停止"均可逐一禁用
- 会话开始询问:打开 app 或 AFK 归来时先问"现在开始学习吗",支持 N 分钟宽限

### 导师 Agent
- **记忆 + 全量上下文**:长期记忆(ai-memory 侧车)之外,聊天与定时反思能直接读取应用内真实数据——任务列表、进行中计时、专注历史、番茄余额、活动明细、当前前台
- 每 10 分钟一次后台反思,沉淀进长期记忆并更新常驻督促语(打断瞬间零 LLM)

### 隐私
- 所有数据只存本地 `%APPDATA%\Dayflow`,选本地模型可完全离线
- 密码管理器等隐私应用:截图替换为灰色占位、标题隐藏
- 浏览器无痕页面不解析网址(历史库匹配天然跳过)

## 快速开始

```bash
npm install
npm run fetch-ai-memory   # 下载 ai-memory 侧车(Rust,本地向量化)
npm run dev               # 开发模式
npm run dist              # 打 Windows 安装包 → release-build/
```

需求:Node 20+,Windows 10/11,无需录屏权限。首次启动按引导配置 AI 提供商。

## AI 提供商

| 提供商 | 说明 |
| --- | --- |
| Gemini | Google AI Studio Key,默认 `gemini-2.5-flash` |
| ChatGPT | OpenAI Key(`gpt-4o-mini`+) |
| Claude | Anthropic Key |
| 智谱 GLM | API 按量计费,或 **GLM Coding Plan** 订阅(Anthropic 兼容网关) |
| 小米 MiMo | API 按量计费,或 Token Plan 订阅 |
| Ollama / LM Studio | 本地模型,**全离线运行** |
| OpenAI 兼容 | 任意端点(vLLM、OpenRouter…) |

时间轴分析需要视觉模型;设置里有「测试连接」。

## 工作原理

1. **抓取** — 窗口轮询(2s)记录前台应用/标题;截图按间隔抓全部显示器并拼接成全景 JPEG(隐私应用→灰占位;锁屏/空闲/暂停→不抓)
2. **分批** — 待分析帧 15 分钟(或 90 帧/静默 3 分钟)成批,>2 分钟空隙自动切分
3. **分析** — 单步时间轴 prompt + 前文卡片(45 分钟回看草稿)+ 带时钟标注的帧 → 你的提供商;返回卡片按批窗口锚定时间戳
4. **失败退避** — 分析失败指数退避(60s→10min),帧保留重试;支持「重析某天」
5. **归类** — 规则引擎优先,浏览器按页面标题/网址细分,LLM 兜底判定新应用

```
%APPDATA%\Dayflow\
  data\dayflow.db          # SQLite:活动/卡片/任务/对话/设置(全内存 + 批量落盘)
  recordings\YYYY-MM-DD\   # 截图帧
```

## 复现演示图

```bash
node tools/demo/seed.mjs init   # 空数据根启动一次,自建 schema
node tools/demo/seed.mjs seed   # 灌入虚构数据
node tools/demo/shoot.mjs       # 启动 app 逐页截图 → docs/images/
```

## 协议

MIT,与上游 [JerryZLiu/Dayflow](https://github.com/JerryZLiu/Dayflow) 一致,见 [LICENSE](LICENSE)。
