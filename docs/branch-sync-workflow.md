# master 单主分支开发工作流

自 2026-10-24 起，原 `vibehub` 的联机部分合入 `master`，停止双分支同步。独立站继续使用原后端，VibeHub 平台使用 P2P；二者都在 master 维护。保留本文件路径以兼容旧文档链接。

## 开发边界

- 所有后续改动直接在 `master` 开发、测试和提交，包括联机层。
- 合并以 master 的素材、主题、游戏节奏、规则、结算界面、AI 与回放分析为基础；VibeHub 只提供登录、房间、P2P 传输、房主权威、恢复与联机战绩等必需能力。
- 共享引擎保留 master 的默认行为；`headless`、`instantOpening`、远端控制器和开局确认屏障只在 P2P 权威端显式启用。
- `vibehub` 分支及工作树保留为历史参考，不再作为开发、提交或部署入口。无需删除或重置它们。
- `sync:vibehub`、同步脚本、领先检查与同步夹具已删除。不要重新运行旧分支里的脚本。

## 当前联机实现

- `src/game/online/useVibeRemoteGame.ts`：VibeHub 联机组合入口。
- `src/game/online/backend.ts`：按域名选择后端，也支持显式 `VITE_ONLINE_BACKEND=ws|vibehub`。
- `src/game/online/ws/useWsOnline.ts`：独立站 WakuDemo 登录与原 HTTP/WS 房间入口；同目录保存独立的协议、状态、开局/结算编排，避免误用 P2P 数据结构。
- `src/components/lobby/ws/`：原后端大厅与服务器 AI 座位配置。牌桌、规则、主题组件和游戏素材仍与 VibeHub 共用。
- `src/game/online/vibe/`：平台登录、房间、大厅、战绩与血流房间。
- `src/game/online/transport/`：VibeHub P2P 传输与可选自托管传输。
- `src/game/online/host/`：经典玩法房主权威引擎与远端控制器。
- `src/game/online/antiCheat/`：承诺洗牌与公开状态校验。
- `signaling/`：可选自托管信令服务，按其 README 单独部署。

`guoguo-labs.online` 及其子域名保留原 REST/WebSocket 房间和 WakuDemo 账号；`*.gamesvibe.app` 使用 VibeHub SDK 登录与 P2P。账号和房间传输必须配套选择，不能只恢复登录卡片却把建房仍接到另一平台。`backend/` 仍是独立 Git 仓库。

## 验证与部署

1. 在 master 运行 `pnpm test`、`pnpm build`，并运行相应单机与本地确定性 e2e。
2. 本地 `mockVibeHub` 用于确定性流程；真实传输、房间、roster、重连、结算同步仍按 AGENTS.md 的线上验收要求执行。
3. 从 master 构建 `dist/` 并用已登录的 VibeHub CLI 更新作品 `B5AJupT1`。`pnpm deploy:vibehub` 使用用户目录内的 CLI 和 `tmp/vibehub-update-note.txt`。
4. 线上验收显式设置 `E2E_ONLINE=1` 和 `E2E_SKIP_WEBSERVER=1`；凭据从未跟踪的 `tmp/online_test` 读取，证据写入 `tmp/bf-online-evidence/`。
5. 本地/CI 默认不收集 `online-*.spec.ts` 与 `selfhost-*.spec.ts`，不依赖私有账号文件或额外信令服务。自托管专项测试设置 `E2E_SELFHOST=1` 后显式运行。
6. 原后端验收设置 `E2E_WS=1`，运行 `tests/e2e/ws-online.spec.ts`。后端使用独立临时数据库并仅监听 `127.0.0.1`；本机夹具创建独立 Cookie 会话，其余房间请求走正常鉴权，验证经典、翻精、血流的两端建房、开局与刷新重连。测试夹具不作为生产服务入口。

```powershell
$env:E2E_ONLINE = '1'
$env:E2E_SKIP_WEBSERVER = '1'
$env:ONLINE_EVIDENCE_DIR = 'tmp/bf-online-evidence'
pnpm exec playwright test tests/e2e/online-two-accounts-two-east-matches.spec.ts --grep '血流东风场' --workers=1
```

## 本次迁移基线

- 原 master：`a8cf544`；迁入的 vibehub：`43899a6`。使用保留双亲历史的合并提交，后续不再同步。独立站 WS 适配随后从原 master 恢复到独立命名空间，修正了合并时误将所有域名接到 VibeHub 的问题。
- `public/`、主题样式、牌桌与结算组件、规则配置保持 master 内容；本地引擎仅增加显式启用的 P2P 权威参数，并保留 master 的分析与复现接线。
- 本地验证：全量单测 2396 项通过、2 项跳过；最终适配检查 51 项通过；类型检查和生产构建通过。
- 浏览器验证覆盖经典/翻精开局、胡牌结算、血流权威整场、刷新恢复、手机主题恢复与倒计时。冷启动导航超时的两项倒计时测试在放宽加载窗口后通过，未修改游戏倒计时。
- 已从 master 更新作品 `B5AJupT1`，并核对线上入口资源与本地构建一致。线上证据保存在 `tmp/bf-online-evidence/20261024-master-p2p/`，不提交账号或测试产物。
- 线上双账号验收两场通过（普通机器人 / 大模型机器人各一场完整东风场）：双方均完成东一至东四，最终积分一致，全知回放与分析记录各有完整四局，无应用异常、决策超时或收帧停滞恢复。
