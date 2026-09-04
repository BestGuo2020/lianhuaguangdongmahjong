# Phase 11V：vibehub 独立适配与线上验收

2026-09-05 完成。代码保留在 `vibehub`，未将 P2P 壳层反向合并到 `master`。

## 交付范围

| 文件 | 改动 | 保留的 P2P 职责 |
|---|---|---|
| `src/App.vue` | 显式装配主题表现属性、变量、字体及 OrientationGate/LlmSettingsPanel 参数；自动重进等待既有 SDK 初始化 Promise | Vibe SDK 登录、房间主题同步/锁定、开局与恢复编排 |
| `src/components/lobby/LobbyView.vue` | 共享双区域大厅、房间聚焦、主题化弹窗、按钮语义与登录区域样式 | 原 props/emits、登录要求、昵称、创建/加入与 AI 配置事件；未引入 WakuDemo/HTTP 房间字段 |
| `src/components/lobby/RoomPanel.vue` | 房间码居中及固定复制反馈位置、紧凑本家入口、移动布局和操作层级 | 房主身份、准备与开局条件、AI 预置选择与两席上限、座位预留、离开/关闭 |

StatsOverlay 与 SettlementOverlay 已处于现有主题上下文，本轮未改写其 P2P 行为。`$vibehubKeep` 未调整，未整文件复制 master 壳层。

实际复现并修复的辅助问题：

- 共享移动 CTA 的 `flex: 0 0 auto` 误作用于房间开始按钮，挤窄准备按钮。先在 master `468f533` 改为仅匹配操作区直接子按钮，再通过标准脚本同步。
- 重进先于 SDK 初始化完成时出现“未初始化或未登录”；App 等待现有初始化，并用空闲状态避免与登录回调重复发起恢复。
- 两个旧 P2P 超时/恢复单测可能在轮到客人前随机胡牌。为它们固定合法洗牌与骰子输入，保留原超时/恢复断言，不改变游戏实现。

## 本地验证

- 类型检查、生产构建及 `git diff --check` 通过。
- 103 个单测文件通过、1 个跳过；945 项通过、2 项跳过。
- `vibehub-llm-theme-sync.spec.ts`：2 项通过，覆盖创建、加入、AI 配置、准备、房主开局和主题同步到双端牌桌。
- `vibehub-presentation.spec.ts`：2 项通过，覆盖五主题场次/玩法/创建/加入弹窗、二次元角色选择、配置抽屉与热切换内容保护，以及双客户端移动房间、AI 两席上限、主题锁定和断线后同身份重进。
- 移动房间覆盖 844×390、800×360、667×375；568×320 允许座位内容区内部滚动，关键操作保持可见。
- 本地联机验证使用仓库既有 BroadcastChannel SDK mock；下面的完整东风场使用真实线上 SDK 与真实账号。
- 生产 JS 检查未命中 `roomSocket`、`WakuDemo`、`/api/rooms`、`/api/login` 或 `new WebSocket`。保留既有大 chunk 构建提示。

本地截图：`test-results/theme-presentation/phase11v/`。复核了五主题大厅/弹层、深色大模型配置、标准移动房间及奶油角色弹窗。

## 发布记录

- CLI：`vibehub-windows-x64.exe update --slug B5AJupT1 --dir dist --note-file tmp/phase11v-release-note.txt`，返回部署成功。
- 作品：<https://vibeapps.lumigrav.space/B5AJupT1/>。
- 受测生产包：`assets/index-CroAsa7s.js`、`assets/index-BKY4yHVX.css`。
- 独立实现：`f14ba9a`；本地与线上测试入口：`ed227f4`；线上稳定结算采样：`f7e2067`。
- 标准同步 `d61d5ad` 后，核对以上三个受保护组件与同步前完全一致；适配未被覆盖。

## 真实线上完整东风场

测试从用户提供的 `tmp/online_test` 运行时读取账号 1、2。凭据未写入源码、发布内容或验收结果。两账号分别运行在独立 Chromium 进程；房主为 1280×720，客人为 844×390 触控横屏。

- 玩法：**莲花麻将（lotus-legacy）**；场次：**东风场**。
- 参与者：两个真实账号 + 两个普通 AI 补位；未注入模型 Key。
- 房间：`PKY8RP`；主题：`llmAnime`，客户端跟随房主且切换入口锁定。
- 用例：`online-two-accounts-two-east-matches.spec.ts` 中“Phase 11V 线上两账号完成莲花麻将完整东风场”。
- 最终验收运行约 **7.3 分钟**，通过。两端完整观察东1～东4；东4两次连庄，总计 **6 次结算**。
- 每次结算在单次 DOM 读取中核对 `data-phase=settled`、结算标题、局号、四家姓名、分数与分差；排除弹层退场帧和新局标题短暂同屏的情况。
- 自动操作只点击实际出牌、胡、过、继续按钮；未修改规则、牌墙、权威状态或结算结果。
- 两端最终排名完全一致，分数合计 8000；无未捕获应用异常；两个账号均已点击返回大厅。

| 名次 | 玩家 | 最终分数 |
|---|---|---:|
| 1 | 适配验收房主 | 10100 |
| 2 | 东山少爷（普通 AI） | 1300 |
| 3 | 适配验收客人 | -800 |
| 4 | 西关十三姨（普通 AI） | -2600 |

最终证据目录：`test-results/theme-presentation/phase11v-online-verified/`。

- `result.json`：两端局号序列、6 次结算分数与最终排名。
- `phase11v-online-东1局-0-settlement-{host,client}.png` 等：每次真实结算截图。
- `phase11v-online-final-host.png`、`phase11v-online-final-client.png`：双端最终排名。

前两次探索运行不计入最终通过证据：第一次脚本读取生产构建不存在的 Vue 调试数据；第二次发现退场层可能被误配到下一局标题后终止。最终运行改为关联已结算状态、标题和实际 DOM 分数，从头完整跑完，结果以上述 `online-verified` 目录为准。
