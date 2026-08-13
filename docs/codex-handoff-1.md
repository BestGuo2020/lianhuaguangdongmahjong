# 莲花麻将玩法接入任务交接记录

- 记录日期：2026-08-13
- 当前状态：核心功能已完成，前后端类型、协议和 UI 已同步；待进行真实多客户端联调、完整后端 API 测试和上线前安全评审。
- 工作目录：`D:\\vueprojects\\lianhua_guangma`

## 1. 本次任务的目标

基于 `docs/lianhua-guangma-rules.md` 和现有前端实现，在后端加入“莲花麻将”玩法，并继续同步前端的玩法选择、类型定义、在线房间协议、牌局状态以及莲花麻将桌面 UI。

目标包括：

1. 保留现有“莲花麻将经典”玩法的兼容性。
2. 新增可独立选择的 `lotus-legacy`（莲花麻将）规则集。
3. 让本地和在线房间都能正确识别、保存和恢复 `rulesetId`。
4. 支持莲花麻将的翻牌、白板万能牌、补花/补杠、吃、碰、杠、抢杠、天胡、地胡、自摸和点炮结算。
5. 将后端提供的莲花麻将状态同步到前端，并在玩法选择和牌桌 UI 中展示。

## 2. 已经完成的内容

### 后端

- 新增 `lotus-legacy` 规则注册项，并保留 `lotus-classic`。
- 新增莲花麻将牌墙、翻牌、白板万能牌和相关状态管理。
- 接入吃、碰、明杠、暗杠、补杠、风杠、抢杠等动作校验和状态流转。
- 接入莲花麻将胡牌模式：普通牌型、七对、十三浪、十三幺，以及天胡、地胡、自摸、点炮。
- 完成莲花麻将结算，包括 2000 底分、点炮支付、自摸支付和特殊胡牌处理。
- 房间创建、房间查询、匹配、WebSocket 快照、重连和数据库持久化均支持 `rulesetId`。
- 补齐 AI、远程玩家和房间状态机对新动作及新规则集的处理。
- 修正点炮结算中实际弃牌物理牌实例的传递问题。
- 增加后端莲花麻将规则的回归测试。

### 前端

- 玩法选择不再强制单人模式；本地 `lotus-legacy` 使用莲花麻将本地引擎，在线房间根据服务端规则集运行。
- 房间创建将选择的 `rulesetId` 发送到后端；加入房间后以服务端房间信息为准同步玩法。
- 扩展在线协议、DTO、解码器、映射器和状态恢复逻辑，支持莲花麻将字段和动作。
- 支持在线吃牌、风杠和服务端胡牌提示。
- 牌桌 UI 展示翻牌、万能牌、第二颗骰子、风杠动作和胡牌提示。
- 本地会根据莲花麻将规则计算可执行的杠牌；在线模式优先使用服务端提供的能力标记。
- 旧版本地会话和旧房间数据缺少 `rulesetId` 时默认回退到 `lotus-classic`，保持兼容。

## 3. 已修改的文件

### 前端文件（项目根目录）

- `src/App.vue`
- `src/components/table/GameTableHud.vue`
- `src/game/online/api/roomApi.ts`
- `src/game/online/orchestration/remoteActionController.ts`
- `src/game/online/orchestration/remoteLobbyController.test.ts`
- `src/game/online/orchestration/remoteLobbyController.ts`
- `src/game/online/orchestration/remoteMatchLifecycle.ts`
- `src/game/online/orchestration/requestCoordinator.ts`
- `src/game/online/orchestration/snapshotReconciler.ts`
- `src/game/online/protocol/decoder.ts`
- `src/game/online/protocol/dto.ts`
- `src/game/online/protocol/mapper.ts`
- `src/game/online/protocol/messages.ts`
- `src/game/online/session/remoteRoomLifecycle.test.ts`
- `src/game/online/session/remoteRoomLifecycle.ts`
- `src/game/online/session/remoteSessionStore.test.ts`
- `src/game/online/session/remoteSessionStore.ts`
- `src/game/online/state/remoteGameState.ts`
- `src/game/online/useRemoteGame.ts`

### 后端文件（`backend/`）

新增：

- `backend/app/core/lotus_wall.py`
- `backend/app/core/lotus_rules.py`
- `backend/app/rules/lotus_legacy.py`
- `backend/app/rules/registry.py`
- `backend/tests/test_lotus_legacy.py`

修改：

- `backend/app/api/rooms.py`
- `backend/app/core/actions.py`
- `backend/app/core/ai.py`
- `backend/app/game/manager.py`
- `backend/app/game/player.py`
- `backend/app/game/remote_player.py`
- `backend/app/game/room.py`
- `backend/app/models/game.py`
- `backend/app/models/messages.py`
- `backend/app/rules/__init__.py`
- `backend/app/rules/base.py`
- `backend/app/rules/lianhua.py`
- `backend/app/settlement.py`
- `backend/app/storage/base.py`
- `backend/app/storage/postgres.py`
- `backend/app/storage/schema_postgres.sql`
- `backend/app/storage/schema_sqlite.sql`
- `backend/app/storage/sqlite.py`
- `backend/app/ws/game_ws.py`

## 4. 每个文件修改了什么

### 前端

- `src/App.vue`：取消莲花麻将只能单人运行的限制；本地莲花麻将切换到 `lotusGame`；监听并同步远程房间 `rulesetId`；将规则集、第二颗骰子传给牌桌 HUD。
- `src/components/table/GameTableHud.vue`：增加规则集和第二颗骰子属性；展示翻牌、万能牌说明和骰子；增加风杠动作文案；在服务端允许时展示胡牌按钮。
- `src/game/online/api/roomApi.ts`：房间信息增加可选 `rulesetId`；创建房间请求增加规则集参数，默认 `lotus-classic`。
- `src/game/online/orchestration/remoteActionController.ts`：增加吃牌选项索引、风杠动作和对应请求方法；胡牌动作支持普通胡牌提示和抢杠胡场景。
- `src/game/online/orchestration/remoteLobbyController.ts`：创建房间动作和控制器接收规则集，并把选中的规则集发送给后端。
- `src/game/online/orchestration/remoteLobbyController.test.ts`：更新创建房间调用断言，覆盖默认经典规则集。
- `src/game/online/orchestration/remoteMatchLifecycle.ts`：牌局重置时清空规则集、第二颗骰子、翻牌、万能牌、牌墙和开局状态等莲花麻将字段。
- `src/game/online/orchestration/requestCoordinator.ts`：保存服务端的 `canHu`、`canWindKong`、吃牌选项，并在不同请求阶段正确清理过期动作能力。
- `src/game/online/orchestration/snapshotReconciler.ts`：从快照恢复 `rulesetId`、第二颗骰子、翻牌、万能牌、补牌堆、开局牌堆和断牌位置。
- `src/game/online/protocol/decoder.ts`：放开吃、风杠、点炮胡等动作；增加风杠、规则集和莲花麻将能力字段校验，同时保持旧协议字段可选。
- `src/game/online/protocol/dto.ts`：扩展服务端杠牌和快照 DTO，增加规则集、骰子、翻牌、万能牌、牌堆和断牌位置字段。
- `src/game/online/protocol/mapper.ts`：将服务端 meld 中的 `windKong` 映射到前端模型。
- `src/game/online/protocol/messages.ts`：扩展回合请求、抢杠/吃碰杠请求、重连成功和牌局结束消息的类型定义。
- `src/game/online/session/remoteRoomLifecycle.ts`：房间生命周期保存、恢复、创建和加入流程支持 `rulesetId`；加入房间后刷新服务端权威规则集。
- `src/game/online/session/remoteRoomLifecycle.test.ts`：更新生命周期测试夹具、创建房间参数和旧会话规则集字段。
- `src/game/online/session/remoteSessionStore.ts`：持久化会话增加可选规则集；旧会话缺少该字段时默认经典玩法。
- `src/game/online/session/remoteSessionStore.test.ts`：补充会话规则集字段的存取测试数据。
- `src/game/online/state/remoteGameState.ts`：向远程状态层暴露规则集、莲花麻将牌墙字段和回合胡牌/风杠能力。
- `src/game/online/useRemoteGame.ts`：消费并返回莲花麻将状态；将规则集传入房间生命周期和动作控制器；增加本地/在线的吃、风杠、杠牌和胡牌能力映射。

### 后端

- `backend/app/core/lotus_wall.py`：实现莲花麻将物理牌墙、翻牌、白板万能牌、补牌堆、断牌位置和补杠相关牌墙操作。
- `backend/app/core/lotus_rules.py`：集中实现莲花麻将牌型识别、万能牌处理、吃碰杠候选、特殊胡牌和相关规则计算。
- `backend/app/rules/lotus_legacy.py`：新增 `lotus-legacy` 规则集适配器，连接规则计算、动作能力和结算配置。
- `backend/app/rules/registry.py`：建立规则集注册表，支持 `lotus-classic` 与 `lotus-legacy` 的解析和默认回退。
- `backend/tests/test_lotus_legacy.py`：覆盖莲花麻将牌型、翻牌/万能牌、动作和结算相关回归场景。
- `backend/app/api/rooms.py`：房间创建和查询接口接收、返回并校验 `rulesetId`。
- `backend/app/core/actions.py`：增加吃牌动作执行入口，并对动作参数做规则集相关处理。
- `backend/app/core/ai.py`：补充 AI 对风杠及莲花麻将能力的决策处理。
- `backend/app/game/manager.py`：接入规则集选择、莲花麻将牌局状态、翻牌/补牌/断牌流程、吃碰杠胡请求、特殊胡牌和结算；修正点炮物理牌实例传递。
- `backend/app/game/player.py`：扩展玩家动作上下文、回合能力和莲花麻将相关状态。
- `backend/app/game/remote_player.py`：让远程玩家支持新动作、能力校验和规则集状态。
- `backend/app/game/room.py`：房间保存规则集，并在快照、重连和牌局生命周期中提供莲花麻将状态。
- `backend/app/models/game.py`：扩展动作、meld、胡牌选项等领域模型，支持吃、风杠和规则集能力。
- `backend/app/models/messages.py`：扩展 WebSocket 请求、响应、快照和牌局结束消息模型。
- `backend/app/rules/__init__.py`：导出新的规则集实现和注册能力。
- `backend/app/rules/base.py`：扩展规则基类能力接口，包含吃牌及莲花麻将需要的动作能力。
- `backend/app/rules/lianhua.py`：明确经典莲花规则与新 legacy 规则的能力边界，避免误把吃牌等能力应用到经典规则。
- `backend/app/settlement.py`：增加莲花麻将的底分、点炮、自摸、天胡、地胡等结算逻辑。
- `backend/app/storage/base.py`：扩展存储层房间/牌局接口，读写规则集。
- `backend/app/storage/postgres.py`：增加 PostgreSQL 规则集字段的迁移和读写。
- `backend/app/storage/schema_postgres.sql`：更新 PostgreSQL 表结构，保存 `ruleset_id`。
- `backend/app/storage/schema_sqlite.sql`：更新 SQLite 表结构，保存 `ruleset_id`。
- `backend/app/storage/sqlite.py`：增加 SQLite 规则集迁移和读写兼容逻辑。
- `backend/app/ws/game_ws.py`：在 WebSocket 建局、重连和快照流程中传递规则集及莲花麻将状态。

## 5. 已运行的测试及结果

### 前端

- `npm run typecheck`：通过。
- `npm run test -- --run`：通过，45 个测试文件、331 个测试全部通过。
- `npm run build`：通过；类型检查和 Vite 构建均成功。
- 构建仍有既有的 chunk 体积提示：`MahjongTable3D` 约 579.85 kB，超过 500 kB 建议阈值；这不是本次功能失败。
- 首次运行 Vitest 时曾遇到 Windows 沙箱 `spawn EPERM`；调整执行权限后测试正常完成。
- `git diff --check`：未发现实际空白错误，只有换行符转换提示。

### 后端

- Python `py_compile`：通过。
- 后端核心/聚焦测试：154 个通过。
- 最新莲花麻将关键测试集合：20 个通过。
- 独立 REST 创建 `lotus-legacy` 房间及 SQLite `ruleset_id` 持久化验证：通过。
- 后端完整 API 测试未能在当前 Windows 环境完整执行：pytest 的 `tmp_path` 临时目录创建受到目录 ACL/权限错误影响。该问题属于测试环境问题，不能视为完整 API 套件通过。

## 6. 当前仍存在的问题

1. 后端完整 API 测试尚未在当前 Windows 环境跑通，需要先解决 pytest 临时目录 ACL/权限问题，再执行完整套件。
2. 尚未进行真实浏览器多客户端端到端联调，尤其需要验证：创建/加入 legacy 房间、准备、开局、翻牌、吃、风杠、抢杠胡、断线重连和牌局结束。
3. 第二颗骰子目前已进入快照和牌桌 UI，但开局事件的动画链路仍需确认；如果需要在 `round_start` 即刻展示，应继续补充该事件字段及动画处理。
4. 后端快照沿用了现有完整牌墙传输方式，未来客户端可能看到未摸到的牌；这是已有的安全设计债务，本次没有扩大或重构该范围。
5. 当前改动尚未完成最终提交、代码审查和 PR 合并；提交前需要分别检查项目根目录和 `backend/` 的工作树状态。

## 7. 下一步应该从哪里继续

建议按以下顺序继续：

1. 启动后端和前端，使用两个或更多浏览器客户端创建并加入 `lotus-legacy` 房间，完成一局最小流程。
2. 重点手工验证翻牌/万能牌、吃牌选项、风杠、抢杠胡、点炮/自摸结算，以及重连后的快照恢复。
3. 解决 Windows pytest 临时目录权限问题，运行后端完整测试套件；若出现业务失败，再按协议字段和规则集逐项定位。
4. 对照后端实际 WebSocket 消息抓包检查前端解码器和 DTO，确认新增字段名称、大小写和可选性完全一致。
5. 决定是否要在本次后续工作中处理完整牌墙泄露问题；如果处理，应单独设计服务端安全快照，不要在前端临时过滤。
6. 根据联调结果补充端到端测试，之后再进行最终 diff 审查、提交和发布。

推荐的交接起点文件：

- 规则注册和后端入口：`backend/app/rules/registry.py`、`backend/app/rules/lotus_legacy.py`、`backend/app/game/manager.py`。
- 前端规则选择和房间流程：`src/App.vue`、`src/game/online/session/remoteRoomLifecycle.ts`、`src/game/online/orchestration/remoteLobbyController.ts`。
- 前端协议和状态恢复：`src/game/online/protocol/decoder.ts`、`src/game/online/protocol/messages.ts`、`src/game/online/orchestration/snapshotReconciler.ts`。
- 莲花麻将桌面展示：`src/components/table/GameTableHud.vue`。

## 8. 哪些内容禁止再次修改

以下内容在没有同步修改设计文档、后端、前端、测试和数据迁移的情况下禁止单独修改：

1. 禁止修改或重命名稳定规则集 ID：`lotus-classic`、`lotus-legacy`。它们同时被房间 API、数据库、WebSocket、前端玩法选择和本地会话使用。
2. 禁止随意修改协议字段名或大小写，包括但不限于：`rulesetId`、`flipTile`、`jokerTiles`、`wildcardTiles`、`flipStack`、`openingStack`、`wallBreakIndex`、`secondDice`、`canHu`、`canWindKong`、`chiOptions`、`optionIndex`。
3. 禁止把 `lotus-legacy` 的规则逻辑直接并入 `lotus-classic`，也禁止恢复 `App.vue` 中“只能单人运行”的旧限制。
4. 禁止绕过规则集注册表，在房间、WebSocket 或前端直接硬编码另一套规则判断；新增玩法必须通过统一的 `rulesetId` 选择。
5. 禁止随意改变莲花麻将物理牌墙、翻牌、白板万能牌、补牌堆、断牌位置、补杠和特殊胡牌的规则常量；任何变化都必须先更新 `docs/lianhua-guangma-rules.md` 和对应测试。
6. 禁止删除旧会话/旧房间缺失 `rulesetId` 时回退到 `lotus-classic` 的兼容逻辑。
7. 禁止改变服务端座位到前端本地座位的映射约定，禁止在重连或快照恢复时泄露其他玩家手牌。
8. 禁止删除或弱化本次新增的规则集、协议、生命周期和结算测试来“绕过”失败；失败应先确认是实现问题还是测试环境问题。
9. 禁止使用破坏性 Git 操作覆盖当前工作区改动；提交前应保留并审查本交接记录及所有未提交文件。

