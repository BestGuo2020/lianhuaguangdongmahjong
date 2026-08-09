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
| 测试 | Vitest |
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

**联机对战**需要配套的后端房间服务：前端默认请求「页面所在主机」的 `8000` 端口（如本机 `http://localhost:8000`）。`backend/` 为独立仓库（本仓库已将其忽略），本地可用 `docker compose up --build` 在 8000 端口启动；部署与运行方式见 [backend/DEPLOY.md](./backend/DEPLOY.md)。同一局域网（或同一域名下）的玩家访问同一页面，即可通过房间码同场对局。后端部署在其他地址时，通过环境变量 `VITE_API_BASE` 指定 API 地址（见「环境变量」）。

## 操作方式

电脑端：鼠标单击出牌

移动端：手机双击出牌或上滑出牌

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动 Vite 开发服务器，监听所有网络接口 |
| `npm run typecheck` | 使用 `vue-tsc` 执行 TypeScript 类型检查，不生成文件 |
| `npm test` | 使用 Vitest 单次运行全部测试 |
| `npm run build` | 先执行类型检查，再生成生产构建 |
| `npm run preview` | 在本地预览生产构建，监听所有网络接口 |

推荐在提交变更前至少运行：

```bash
npm test
npm run build
```

## 环境变量

客户端环境变量均以 Vite 的 `VITE_` 前缀声明，参考模板见 `.env.example`：

- `VITE_API_BASE`（可选）：联机模式后端 API 地址。默认 `http://<页面所在主机>`（即同主机 8000 端口，见「本地运行」）；后端部署到独立域名/端口时设置，例如 `VITE_API_BASE=https://api.example.com`。构建时以 `import.meta.env` 注入。

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
│  │  ├─ MahjongTable3D.vue # Three.js 牌桌与 3D 场景
│  │  ├─ MahjongTile.vue    # 2D 麻将牌组件
│  │  ├─ PlayerSeat.vue     # 玩家座位与状态展示
│  │  └─ RulesPanel.vue     # 游戏内玩法说明面板（含用户声明）
│  ├─ content/
│  │  └─ disclaimer.ts      # 纯娱乐声明文案（声明弹窗与玩法面板共用）
│  ├─ game/
│  │  ├─ core/              # 离线核心：对局、规则、AI、布局与胡牌演出
│  │  │  ├─ useGame.ts      # 对局状态、回合流程和玩家/AI 操作
│  │  │  ├─ rules.ts        # 胡牌判断、杠分、胡牌计分与买马
│  │  │  ├─ tiles.ts        # 牌集合、牌墙、排序和牌名工具
│  │  │  ├─ tableLayout.ts / wallLayout.ts # 牌桌与牌墙布局
│  │  │  ├─ winEffect.ts    # 胡牌展示布局与动效时序
│  │  │  ├─ ai.ts / playerController.ts / actions.ts # 本地 AI 与动作执行
│  │  │  ├─ types.ts / useAudio.ts / avatar.ts / tileAssets.ts
│  │  │  └─ *.test.ts       # Vitest 单元与流程测试
│  │  └─ online/            # 联机交互：房间生命周期与对局同步
│  │     ├─ remoteApi.ts    # 房间 REST 客户端（创建/加入/准备/离开/关闭/举报/战绩）
│  │     └─ useRemoteGame.ts # 联机状态机与 WebSocket 对局同步
│  ├─ App.vue               # 应用界面、交互入口和响应式适配
│  ├─ main.ts               # Vue 应用入口
│  ├─ style.css             # 全局样式
│  └─ env.d.ts              # Vite 类型声明
├─ docs/                    # 项目参考图片
├─ index.html               # Vite HTML 入口
├─ vite.config.ts           # Vite 与开发服务器配置
├─ tsconfig.json            # TypeScript 配置
├─ package.json             # 依赖与 npm 脚本
└─ package-lock.json        # npm 依赖锁文件
```

`dist/`、`node_modules/`、`tmp/` 和本地日志属于生成物或本地工作文件，不应作为业务源码维护。

## 开发规范

- 使用 Vue 单文件组件和 `<script setup lang="ts">`；可复用的游戏逻辑放在 `src/game/core/`（离线核心）与 `src/game/online/`（联机交互），展示逻辑放在 `src/components/`。
- 保持现有代码风格：2 空格缩进、单引号、通常不写行末分号。
- 共享的牌、玩家、动作和结算结构应在 `src/game/core/types.ts` 中定义，避免在组件内重复声明。
- 修改规则时同时检查 `rules.ts`、`useGame.ts`、游戏内 `RulesPanel.vue` 与本 README，确保实现和说明一致。
- 修改牌桌位置或胡牌演出时，优先更新相应的纯函数，并补充或调整测试。
- 静态资源放入 `public/` 对应子目录，运行时代码使用 `import.meta.env.BASE_URL` 构建 URL，以避免硬编码站点根路径。
- 不直接编辑 `dist/`；生产文件必须由构建命令重新生成。
- 当前项目中未发现 ESLint、Prettier、提交信息规范或贡献流程说明。

## 构建和部署

生成生产版本：

```bash
npm run build
```

该命令会先运行类型检查，再由 Vite 将静态文件输出到 `dist/`。本地检查构建结果：

```bash
npm run preview
```

部署时将 `dist/` 的内容交给能够托管静态站点的 Web 服务器即可。联机模式需同时部署后端房间服务：`backend/` 为独立仓库，已配置 GitHub Actions 自动构建镜像并推送到服务器（见 [backend/DEPLOY.md](./backend/DEPLOY.md)），前端通过 `VITE_API_BASE` 指向该服务。

当前 `vite.config.ts` 未设置自定义 `base`，默认按站点根路径构建。如果部署到域名的子路径，需要先根据目标环境配置 Vite 的 `base`，并确认 `public/` 下的音频、图片和头像均能正确加载。应用当前没有前端路由，因此不需要额外配置 SPA 路由回退。

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

如果站点部署在子路径而不是域名根路径，请配置 Vite 的 `base` 后重新构建。不要直接修改 `dist/` 中生成的 URL。

### 联机模式创建 / 加入房间失败

确认后端房间服务已启动且端口可达（默认页面所在主机的 `8000` 端口，见「本地运行」）；浏览器访问的地址与后端 API 需能互通，同一局域网跨设备时确认防火墙放行对应端口。若后端部署在其他地址，请设置 `VITE_API_BASE` 后重新构建，不要直接修改 `dist/`。

### 修改规则后测试失败

规则测试位于 `src/game/core/*.test.ts` 与 `src/game/online/*.test.ts`。确认规则实现、对局流程、计分预期和玩法文案都已同步更新，然后重新运行 `npm test` 和 `npm run build`。

## 资源说明

示例头像由 [DiceBear Adventurer](https://www.dicebear.com/styles/adventurer/) 生成，原始设计作者为 Lisa Wischofsky，采用 CC BY 4.0 许可。

项目代码许可见 [LICENSE](./LICENSE)。
