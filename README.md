# 莲花广麻

[![GitHub Stars](https://img.shields.io/github/stars/BestGuo2020/lianhuaguangdongmahjong?style=flat&logo=github)](https://github.com/BestGuo2020/lianhuaguangdongmahjong/stargazers)
[![License](https://img.shields.io/github/license/BestGuo2020/lianhuaguangdongmahjong)](./LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-%5E20.19.0%20%7C%7C%20%3E%3D22.12.0-339933?logo=nodedotjs&logoColor=white)
![npm](https://img.shields.io/badge/npm-%3E%3D9.0.0-CB3837?logo=npm&logoColor=white)
![Vue](https://img.shields.io/badge/Vue-3.5-42b883?logo=vuedotjs&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)

一款使用 Vue 3 和 Three.js 实现的四人麻将游戏，视觉风格参考传统 PC 麻将房。支持**单机对战**（本家与三名本地 AI 对局）和**联机对战**（创建房间或输入 6 位房间码加入，与真实玩家同场），两种模式均可选择东风场或半庄场。

> 玩法按作者第一次接触的莲花广麻规则实现，部分计分细节可能与其他地区或牌馆的规则存在差异。实际行为以本项目代码和游戏内“玩法”面板为准。

## 声明

本游戏为纯娱乐棋牌游戏，游戏内所有积分、道具仅为本游戏内部虚拟娱乐数值，不具备任何现金价值，不可兑换人民币、实物、有价资产，不支持任何形式回购、变现、折现、线下结算。用户确认知晓：本游戏不提供赌博相关任何功能。

用户承诺，不得利用本游戏平台、游戏房间、对局功能、聊天功能实施赌博、变相赌博行为，包括但不限于：

1. 以本游戏对局结果为依据，在线下通过微信、支付宝或其他任何渠道进行现金、财物赌注、结算输赢；
2. 在游戏聊天、房间名称、昵称、签名中发布赌博邀约、赌资结算联系方式、赌博黑话等信息；
3. 组织、招揽他人利用本游戏开展线下赌局；
4. 协助他人进行赌博、传递赌博联络信息。

平台严禁一切赌博及变相赌博行为。一经平台通过系统风控、用户举报、人工核查发现用户存在上述违规行为，平台有权视情节采取警告、禁言、限制创建房间、冻结账号、永久封禁账号等处置措施，并留存相关记录。

用户如实施赌博违法行为，一切法律责任由该用户本人自行承担。如有关国家机关依法调查，平台将依法向司法、公安部门提交用户登录日志、房间记录、聊天记录等留存数据，配合调查取证。

用户如发现其他用户存在赌博、违规邀约行为，请使用游戏内举报功能提交线索，平台将对举报信息进行核查处理。

### 免责提示

平台仅提供游戏娱乐技术服务，无法监控用户游戏之外的线下私下转账、私下财物交易行为。若用户之间私下在游戏外进行赌博财物往来，该行为与本平台无关，由此产生的全部纠纷、法律后果均由参与该行为的用户自行承担。

### 部署与运营免责声明

本项目为开源娱乐软件，作者仅提供源代码与必要的技术支持，不参与、不组织、不授权任何个人或机构的部署与运营行为。部署者（含服务器所有者、运维人员、房间运营者）使用本项目时，应自行确保：

1. 部署与运营行为符合部署所在地的法律法规，仅在合法合规的场景下运行本软件；
2. 不得利用本项目从事赌博、变相赌博或任何其它违法违规活动；
3. 若本软件被用于任何违法违规用途，由此产生的全部法律责任由实际部署者、运营者自行承担，与作者无关。

作者无法监控任何第三方部署实例的实际用途，亦不对任何未经作者控制的部署实例及其产生的行为负责。

## 游戏截图

![莲花广麻对局界面](./docs/QQ20260801-222700.png)

## 技术栈

| 分类 | 技术 |
| --- | --- |
| 前端框架 | Vue 3（Composition API、单文件组件） |
| 开发语言 | TypeScript |
| 3D 渲染 | Three.js |
| 构建工具 | Vite 8 |
| 类型检查 | vue-tsc |
| 测试 | Vitest（单元/契约测试）、Playwright（端到端测试） |
| 包管理 | npm（仓库包含 `package-lock.json`） |

前端为单页应用，可独立运行单机模式；联机模式需要配套的后端房间服务（见「本地运行」）。`package.json` 已通过 `engines` 声明运行环境：Node.js `^20.19.0 || >=22.12.0`，npm `>=9.0.0`。

## 功能概览

- 单机四人对局：一名玩家与三名本地 AI。
- 东风场（4 局）和半庄场（8 局）两种模式。
- 3D 麻将桌、牌墙、手牌、副露与弃牌展示。
- 发牌、掷骰、摸打、碰、明杠、暗杠、补杠、自摸及抢杠胡流程。
- 听牌提示、待牌剩余数量、回合倒计时、积分变化与局末排名。
- 触屏移动设备竖屏时提示切换横屏，并尝试进入横屏全屏模式。
- 联机对战：创建 4 人房间或输入 6 位房间码加入，房主控制准备/开始；断线可凭会话重连回原座位，空位与离席由 AI 代打。
- 房间管理：房间限时自动解散、房主离开解散，大厅实时展示剩余房间数。
- 个人战绩与举报：按匿名身份累计场次/胡牌/净胜分，局末可举报对局中的玩家。
- 牌型判断、计分、牌桌布局、比赛推进和胡牌演出等自动化测试。

### 当前实现的主要规则

- 只碰、杠，不吃牌。
- 仅支持自摸与抢杠胡，不支持普通弃牌点炮。
- 白板作为癞子，可替代对子、刻子或顺子所需的牌。
- 底分为 100；庄家 ×2，无白板胡牌 ×2，四张红中胡牌额外 ×4，杠上开花 ×2。
- 摸到红中会立即亮杠，并从牌墙尾部补摸；累计四张红中立即按自摸结算。
- 胡牌后从牌墙摸最多 8 张马牌；1、5、9 和红中为中马，每张增加一份底分。
- 暗杠由其余三家各支付 2 份底分；明杠由出牌者支付 1 份底分；补杠由其余三家各支付 1 份底分。
- 抢杠胡只由被抢杠者支付胡牌分数。
- 胡牌单家支付额：`底分 × 倍数 + 中马数 × 底分`。

## 前端架构

前端目前以统一的 `GamePort` 作为界面与对局实现之间的边界。`App.vue` 只负责应用级组合：根据当前模式选择本地或远程端口，并装配大厅、牌桌 HUD、结算层、战绩层和声明弹窗。牌桌与结算组件不直接判断本地/联机分支，两种模式向上提供同一套状态和动作契约。

```text
Vue 页面与组件
      │
      ▼
activeGamePort / GamePort
      ├─ 本地：useGame → 本地回合、动作、时间线与规则模块
      └─ 联机：useRemoteGame → 编排层 → 协议层 → REST / WebSocket
```

- `src/game/core/contracts/` 定义共享领域类型、`GamePort` 以及本地/联机端口选择器，并通过契约测试保证两种实现可以被相同 UI 消费。
- 本地对局按规则、控制器、状态、回合编排、杠执行器、开局/结算时间线和瞬态表现拆分；`useGame.ts` 仅保留组合与对外适配职责。
- 联机对局按 API、协议、传输、会话、状态、编排和表现分层。服务端数据先由 decoder 校验，再经 mapper 转换为前端领域模型，随后由消息路由和 snapshot reconciler 驱动状态。
- 房间创建、加入、准备、开局、离开、恢复和继续对局均由独立生命周期模块处理；断线恢复使用本地会话信息重新连接并接受服务端快照。
- Three.js 场景将静态牌桌、中央机器、牌面/材质、牌墙/手牌/弃牌/副露实例渲染、骰子和胡牌特效分别封装；3D 牌桌与规则面板按需加载，避免大厅首屏加载完整渲染代码。

## 安装方式

### 前置条件

- Node.js `^20.19.0 || >=22.12.0`
- npm `>=9.0.0`

克隆或下载项目后，在仓库根目录安装锁定版本的依赖：

```bash
npm ci
```

如果正在主动更新依赖，可使用 `npm install`；普通开发和 CI 环境优先使用 `npm ci`，以保持与 `package-lock.json` 一致。

## 本地运行

启动开发服务器：

```bash
npm run dev
```

Vite 配置的默认端口为 `4173`，开发服务器监听 `0.0.0.0`。通常可在浏览器打开：

```text
http://localhost:4173
```

终端输出的地址应作为最终依据。如果端口已被占用，Vite 可能选择其他可用端口。

进入大厅后选择“东风场”或“半庄场”开始单机对战，或在“联机对战”下创建/加入房间。移动端建议横屏使用；部分浏览器不允许网页自动锁定方向，此时请手动横置设备。

**联机对战**需要配套的后端房间服务。开发环境下，前端请求同源的 `/api` 和 `/ws`，Vite 会将它们代理到 `http://127.0.0.1:8000`；`backend/` 为独立仓库（本仓库已将其忽略），本地可用 `docker compose up --build` 启动，部署与运行方式见 [backend/DEPLOY.md](./backend/DEPLOY.md)。生产环境建议让 Web 服务器将 `/api`、`/ws` 反向代理到后端；如果后端使用独立地址，则通过 `VITE_API_BASE` 指定（见「环境变量」）。

## 操作方式

电脑端：鼠标单击出牌

移动端：手机双击出牌或上滑出牌

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动 Vite 开发服务器，监听所有网络接口 |
| `npm run typecheck` | 使用 `vue-tsc` 执行 TypeScript 类型检查，不生成文件 |
| `npm test` | 使用 Vitest 单次运行 `src/` 下的单元、流程和契约测试 |
| `npm run test:e2e` | 使用 Playwright 运行浏览器端本地对局冒烟测试 |
| `npm run build` | 先执行类型检查，再生成生产构建 |
| `npm run preview` | 在本地预览生产构建，监听所有网络接口 |

推荐在提交变更前至少运行：

```bash
npm test
npm run build
npm run test:e2e
```

## 环境变量

客户端环境变量均以 Vite 的 `VITE_` 前缀声明：

- `VITE_API_BASE`（可选）：联机模式 REST 与 WebSocket 的服务基址。默认使用页面当前 origin；本地开发由 Vite 代理 `/api`、`/ws` 到 `127.0.0.1:8000`。后端部署到独立域名或端口时设置，例如 `VITE_API_BASE=https://api.example.com`。该值在构建时通过 `import.meta.env` 注入。

代码通过 Vite 内置的 `import.meta.env.BASE_URL` 拼接音频、图片和头像资源路径。不要把密钥放入前端环境变量或提交到仓库。

## 目录结构

```text
.
├─ public/                  # 构建时原样复制的静态资源
│  ├─ audio/               # 背景音乐、操作和牌面语音
│  ├─ avatars/             # 玩家头像
│  ├─ img/                 # 界面图标
│  └─ tiles/               # 麻将牌面图片
├─ src/
│  ├─ components/
│  │  ├─ lobby/              # 大厅与联机房间面板
│  │  ├─ table/              # 牌桌 HUD 与 Three.js 子模块
│  │  │  └─ three/           # 静态场景、实例渲染、骰子、特效与性能调节
│  │  ├─ settlement/         # 局末/比赛结算覆盖层
│  │  ├─ account/            # 战绩覆盖层
│  │  ├─ legal/ / shell/     # 声明、应用外壳与横屏门禁
│  │  ├─ MahjongTable3D.vue  # 3D 场景组合入口
│  │  ├─ MahjongTile.vue / PlayerSeat.vue
│  │  └─ RulesPanel.vue      # 按需加载的玩法说明
│  ├─ content/
│  │  └─ disclaimer.ts      # 纯娱乐声明文案（声明弹窗与玩法面板共用）
│  ├─ game/
│  │  ├─ core/
│  │  │  ├─ contracts/       # GamePort、共享类型及契约测试
│  │  │  ├─ rules/           # 牌、动作、胡牌、计分与牌墙规则
│  │  │  ├─ controllers/     # AI 与玩家动作决策
│  │  │  ├─ local/           # 本地状态、生命周期、回合/动作编排和表现时间线
│  │  │  ├─ selectors/       # 可供本地和远程复用的派生查询
│  │  │  └─ presentation/    # 音频、头像、牌面资源和布局/胡牌表现模型
│  │  └─ online/
│  │     ├─ api/             # 房间、账号、举报 REST 客户端
│  │     ├─ protocol/        # 服务端 DTO、消息、decoder 与 mapper
│  │     ├─ transport/       # 房间 WebSocket
│  │     ├─ session/         # 会话持久化、房间恢复与可用性
│  │     ├─ state/           # 远程对局状态容器
│  │     ├─ orchestration/   # 请求协调、消息路由、快照协调与动作/生命周期
│  │     ├─ presentation/    # 开局、结算和瞬态事件表现时间线
│  │     └─ useRemoteGame.ts # 远程端口组合入口
│  ├─ App.vue                # 应用组合根，不承载具体对局规则
│  ├─ main.ts               # Vue 应用入口
│  ├─ style.css             # 全局样式
│  └─ env.d.ts              # Vite 类型声明
├─ tests/e2e/                # Playwright 浏览器冒烟测试
├─ .github/workflows/        # 前端持续集成
├─ docs/                    # 项目参考图片
├─ index.html               # Vite HTML 入口
├─ vite.config.ts           # Vite 与开发服务器配置
├─ tsconfig.json            # TypeScript 配置
├─ package.json             # 依赖与 npm 脚本
└─ package-lock.json        # npm 依赖锁文件
```

`dist/`、`node_modules/`、`tmp/` 和本地日志属于生成物或本地工作文件，不应作为业务源码维护。

## 开发与扩展约定

- 使用 Vue 单文件组件和 `<script setup lang="ts">`。组件只消费 `GamePort`，不要在视图内新增本地/联机模式分支或直接解析后端 DTO。
- 共享的牌、玩家、动作和结算类型放在 `src/game/core/contracts/`；协议原始类型只放在 `src/game/online/protocol/dto.ts`，并经过 decoder 与 mapper 后才能进入核心状态。
- 本地与远程组合入口分别为 `src/game/core/local/useGame.ts` 和 `src/game/online/useRemoteGame.ts`。新流程优先下沉到对应的状态、编排、控制器或时间线模块，避免组合入口再次膨胀。
- 修改规则时同步更新 `src/game/core/rules/`、本地动作/结算流程、游戏内 `RulesPanel.vue` 和本 README；若后端权威计算也依赖该规则，还需要同步后端并补充协议映射测试。
- 新增一套麻将规则时，优先把规则差异封装为规则配置或策略，复用 `GamePort`、房间生命周期、协议传输和 UI 外壳。只有服务端 DTO 新增字段时才扩展 `dto.ts`、decoder 和 mapper；只有 UI 需要新状态/动作时才扩展 `GamePort`，并同步本地、远程契约测试。
- 修改牌桌位置、实例渲染或胡牌演出时，优先更新 `src/components/table/three/` 或 `src/game/core/presentation/` 中的独立模块，并补充纯函数/渲染器测试。
- 保持现有代码风格：2 空格缩进、单引号、通常不写行末分号。静态资源放入 `public/` 对应目录，运行时使用 `import.meta.env.BASE_URL` 构建 URL。
- 不直接编辑 `dist/`；生产文件必须由构建命令重新生成。当前仓库尚未配置 ESLint、Prettier 或提交信息规范。

## 构建和部署

生成生产版本：

```bash
npm run build
```

该命令会先运行类型检查，再由 Vite 将静态文件输出到 `dist/`。本地检查构建结果：

```bash
npm run preview
```

部署时将 `dist/` 的内容交给能够托管静态站点的 Web 服务器即可。联机模式需同时部署后端房间服务：`backend/` 为独立仓库，部署方式见 [backend/DEPLOY.md](./backend/DEPLOY.md)。可以通过同源反向代理暴露 `/api`、`/ws`，也可以通过 `VITE_API_BASE` 指向独立服务地址。

当前 `vite.config.ts` 使用相对路径 `base: './'`，可将构建产物部署到根路径或未知子目录；子目录地址应以 `/` 结尾，避免浏览器将相对资源解析到错误层级。应用当前没有前端路由，因此不需要额外配置 SPA 路由回退。

## 常见问题

### `npm ci` 提示 Node.js 版本不兼容

请确认 `node --version` 满足 `^20.19.0 || >=22.12.0`，并确认 `npm --version` 不低于 `9.0.0`。Node.js 21、低于 22.12.0 的 Node.js 22，以及低于 20.19.0 的 Node.js 20 均不在当前约束范围内。升级运行环境后重新执行 `npm ci`。

### `4173` 端口无法访问

先查看 `npm run dev` 的终端输出，确认 Vite 实际使用的端口。若从同一局域网的其他设备访问，还需使用开发机的局域网 IP，并确认系统防火墙允许该端口。

### 页面有画面但没有声音

浏览器通常要求用户先进行一次交互才能播放音频。请点击开始游戏，并确认界面未静音、浏览器标签页未静音，且 `public/audio/` 中的资源可以正常访问。

### 手机一直提示切换横屏

游戏在触屏、小尺寸且竖屏的设备上启用横屏提示。点击提示可尝试进入横屏全屏；若浏览器不支持方向锁定，请手动旋转设备，或更换支持相关 Fullscreen/Screen Orientation API 的浏览器。

### 构建后静态资源返回 404

确认站点通过带尾斜杠的目录地址访问，例如 `/项目名/`，并确认 Web 服务器没有重写掉构建产物的相对路径。不要直接修改 `dist/` 中生成的 URL。

### 联机模式创建 / 加入房间失败

本地开发时确认后端监听 `127.0.0.1:8000`，并通过 Vite 页面访问，让 `/api`、`/ws` 使用开发代理。部署环境则检查同源反向代理或 `VITE_API_BASE`，并确认 WebSocket 升级请求未被代理层拦截。若“继续对局”不能恢复，还应检查浏览器会话存储、房间是否仍存在，以及后端返回快照能否通过协议 decoder。

### 修改规则后测试失败

单元、流程和契约测试与实现文件并置在 `src/game/core/**`、`src/game/online/**` 和 `src/components/table/three/**`，浏览器冒烟测试位于 `tests/e2e/`。确认规则实现、两种 GamePort、计分预期和玩法文案均已同步，再运行 `npm test`、`npm run build` 和 `npm run test:e2e`。

## 资源说明

示例头像由 [DiceBear Adventurer](https://www.dicebear.com/styles/adventurer/) 生成，原始设计作者为 Lisa Wischofsky，采用 CC BY 4.0 许可。

项目代码许可见 [LICENSE](./LICENSE)。
