# 莲花广麻 LLM、TTS 与 VibeHub 多人模式交接记录

> 更新时间：2026-08-23（Asia/Shanghai）  
> 目的：将本轮关于 LLM 提示词、前后端模型接入、VibeHub 房主代理、AI 气泡与 TTS 的连续讨论和实施结果整理成可继续开发的上下文。  
> 注意：本文只记录配置名称和架构，不包含任何 API Key、Secret Key、访问令牌或凭据文件内容。

## 1. 一页结论

当前已经形成三条彼此独立的运行路径：

1. **前端单机**：浏览器使用本地配置的大模型；语音只调用独立的 Python TTS 网关，不依赖 Python 联机房间或后端 LLM Key。
2. **`master` 多人联机**：Python 后端负责大模型决策、消息广播、日志和 TTS；客户端只选择后端公开的 providerId，不接触服务端 Key。
3. **`vibehub` 多人联机**：房主浏览器负责调用大模型并广播权威 AI 消息；各客户端根据消息中的公开音色标识调用已部署的 TTS 网关。房主的大模型 Key 不会广播给其他玩家。

当前用户最后讨论的新方向是：**评估火山引擎豆包语音合成大模型，可能作为主 TTS，保留百度作为降级**。这还只是建议，尚未编写火山引擎代码。

## 2. 仓库、分支与部署状态

### 2.1 前端仓库

- 路径：`D:/vueprojects/lianhua_guangma`
- 当前检出分支：`vibehub`
- 当前提交：`87efc23 feat(vibehub): use 20 second LLM budget`
- `vibehub` 与 `origin/vibehub` 一致。
- 本地 `master` 当前提交：`75115e0 feat: extend LLM decision budget to 20 seconds`
- 本地 `master` 比 `origin/master` 多 25 个提交，尚未推送。

必须继续遵守仓库根目录 `AGENTS.md` 的双分支规则：

- UI、规则、牌桌共享功能先在 `master` 修改并提交。
- 然后运行 `pnpm sync:vibehub` 同步。
- VibeHub 专属联机层只在 `vibehub` 维护，并尊重同步脚本的 `$vibehubKeep` 清单。

当前前端工作区还有两份用户已有的未跟踪测试文件，本轮未修改、未删除：

- `tests/e2e/online-four-humans-east-observation.spec.ts`
- `tests/e2e/online-three-users-hanchan.spec.ts`

### 2.2 Python 后端仓库

- 前端仓库中的 `backend/` 是独立 Git 仓库的 linked worktree。
- 分支：`main`
- 当前提交：`e3436c7 feat: extend LLM decision timeout to 20 seconds`
- 本地比 `origin/main` 多 2 个提交：
  - `92da4ec feat: throttle multiplayer LLM speech`
  - `e3436c7 feat: extend LLM decision timeout to 20 seconds`
- 用户已说明 Python 后端已经部署，但以上 Git 提交仍未推到 `origin/main`，接手时不要把“已部署”误认为“远端仓库已同步”。

### 2.3 当前服务地址

- 独立 TTS 网关基址：`https://www.bestguo.top:58000`
- `src/game/llm/localTtsClient.ts` 对 `*.lumigrav.space` 默认使用上述地址。
- 本地开发默认走同源 `/api`，由 Vite 代理转发，避免浏览器 PNA/CORS 和 `localhost`/`127.0.0.1` 混用问题。
- 讨论和测试中使用过的 VibeHub 页面：`https://vibeapps.lumigrav.space/B5AJupT1/?release=llm-host-20260823`

## 3. 已确认的产品与规则决策

### 3.1 麻将规则必须由规则引擎约束

- 同时支持“莲花广麻”和“莲花麻将”。
- 玩法不支持的牌型不能由大模型自行发明。例如当前玩法不支持七对，Prompt 必须明确说明，候选动作也必须由规则引擎生成。
- LLM 只在候选 ID 中选择，不负责判定一个动作是否合法。
- 癞子、精牌保护应在候选生成和响应校验层完成，不能只在 Prompt 中口头提醒。

### 3.2 单机与多人模型配置必须分离

- 单机大模型配置保留在浏览器本地。
- Python 多人房间使用服务端 provider 注册表，Key 只在服务器。
- VibeHub 多人房间由房主浏览器使用自己的本地大模型配置代理调用，公开给其他玩家的只能是昵称、头像目录、风格、音色标识等非敏感身份。

### 3.3 VibeHub 至少两名真人开局

- 房主不能独自与 3 个 AI 开局。
- 最多硬预留 2 个大模型座位，始终给第二名真人保留至少一个位置。
- 真人加入时必须跳过已经硬预留的大模型座位。

### 3.4 AI 语音行为

- 大模型座位不播放原生的报牌、吃、碰、杠语音，主要播放模型吐槽。
- 保留统一的出牌落桌/碰撞效果，避免只有本家有出牌反馈。
- AI 自摸或吃胡必须用 TTS 说出来，属于重要台词。
- 真人座位不能因为历史上曾配置为 AI，就错误播放 AI TTS。
- 播放 TTS 时降低背景音乐音量，结束后恢复。

### 3.5 决策总预算

- 前端单机、VibeHub 房主代理和 Python 后端统一使用 **20 秒 LLM 决策总预算**。
- 总预算包含排队、HTTP、解析和至多一次语义重试，不应每个阶段各自再获得完整 20 秒。

## 4. 本轮已完成的主要工作

### 4.1 LLM 设计文档与 Prompt

`docs/llm-ai-design.md` 已合入此前的评审意见：

- `CandidateFeatures` 补充 `scoreDeltaBand`。
- 修正 v1 Prompt 示例中混入 v2“向听数”的问题。
- `efficiency` 同分排序补充稳定 tie-break。
- 平衡括号 JSON 扫描器要求跳过字符串字面量和转义序列。
- Prompt 框架补充两种莲花玩法的明确规则，避免模型凭通用麻将知识凑出不支持的七对等牌型。
- 前后端候选协议和总超时约定已统一到 20 秒。

关键文件：

- `docs/llm-ai-design.md`
- `src/game/llm/prompt.ts`
- `backend/app/llm/prompt.py`
- `src/game/llm/candidateBuilder.ts`
- `backend/app/llm/candidates.py`
- `backend/app/llm/validation.py`

### 4.2 前端单机与 Python 联机配置解耦

- 前端单机继续使用浏览器中的 provider preset。
- 多人 WebSocket 房间只展示 Python 后端公开的模型 provider。
- 每个已配置模型都展开为“激进、稳健、话痨、高冷”四种可选策略。
- 下拉框样式已经改成暗色，修复原生选项/分组白底过亮的问题。
- provider 的昵称、头像和模型名可显示在座位及选择器中。

相关提交：

- 前端 `9f3888d refactor: separate local and online LLM configuration`
- 前端 `9644d52 feat: expose all LLM strategies per model`
- 后端 `ff28d4a feat: decouple server LLM room providers`
- 后端 `2aceba9 feat: allow per-seat LLM strategy overrides`

### 4.3 癞子、精牌保护

后端已修复大模型把癞子或精牌作为普通弃牌候选的问题：

- 候选生成阶段保护关键牌。
- Prompt 明确标注保护原因。
- 响应校验拒绝越过规则候选集的选择。
- 非法或超时继续走确定性 AI 回退，不能卡住对局。

相关提交：`6fcca70 fix: protect jokers from LLM discards`

### 4.4 多人日志、气泡、头像和座位身份

- Python 后端会广播和记录每条 LLM 牌桌消息。
- 场次结束记录每个 AI 的请求、成功、回退、吐槽等汇总，并逐条记录吐槽。
- 多人牌桌支持显示 AI 吐槽气泡。
- PC 端气泡文字已经放大。
- 右下角及多人模式的 `🤖` 已替换为 `img/robot.svg`。
- 修复客户端视角的座位旋转：服务端座位先转换为本地座位，再用于气泡和语音。

关键文件：

- `backend/app/game/room.py`
- `src/components/table/GameTableHud.vue`
- `src/game/online/useRemoteGame.ts`
- `src/game/online/useVibeRemoteGame.ts`
- `src/game/core/local/localSettlementTimeline.ts`
- `src/game/variants/lotus/lotusSettlement.ts`

### 4.5 百度 TTS、缓存和单机独立网关

Python 后端已经实现百度 TTS：

- Token 获取与复用。
- MP3 文件缓存和缓存元数据。
- 并发限制、负缓存、容量和过期清理。
- 文本、策略、音色参数参与缓存键。
- 联机房间 TTS 与单机 TTS 网关的缓存目录和服务入口彼此独立。
- 开发机可从 `backend/docs/百度api-key.txt` 读取凭据，环境变量优先；该文件不可提交。
- 已提供 `python -m app.tts.check` 和 `python -m app.local_tts.check` 检查入口。

单机网关接口：

- `POST /api/local-tts/synthesize`
- `GET /api/local-tts/audio/{cacheKey}.mp3`

此前实测输出：

```text
TTS available=True
TTS success bytes=19008
```

这表示百度鉴权、请求和音频返回链路成功。

关键文件：

- `backend/app/tts/`
- `backend/app/local_tts/`
- `backend/app/api/tts.py`
- `backend/app/api/local_tts.py`
- `src/game/llm/localTtsClient.ts`
- `src/game/core/presentation/llmAudioBus.ts`
- `src/game/core/presentation/useAudio.ts`

### 4.6 音色配置的当前优先级

当前代码支持两层参数：

1. **策略层**：`AGGRESSIVE / STEADY / TALKATIVE / COLD` 分别配置 `VOICE/SPEED/PITCH/VOLUME/EMOTION`。
2. **provider 层**：`BAIDU_TTS_<FIELD>_PROVIDER_<ID>` 可以逐字段覆盖策略结果。

用户最后确认的意图是：

- DeepSeek 和 GPT 可以有不同基础音色。
- 激进、稳健、话痨、高冷仍应主要由不同的语速、音调和音量组合体现。
- 因此部署环境里建议只保留 provider 级 `VOICE`，删除以下 provider 级速度、音调和音量覆盖，否则四种策略的差异会被覆盖：

```ini
BAIDU_TTS_SPEED_PROVIDER_DEEPSEEK
BAIDU_TTS_PITCH_PROVIDER_DEEPSEEK
BAIDU_TTS_VOLUME_PROVIDER_DEEPSEEK
BAIDU_TTS_SPEED_PROVIDER_RELAY_GPT
BAIDU_TTS_PITCH_PROVIDER_RELAY_GPT
BAIDU_TTS_VOLUME_PROVIDER_RELAY_GPT
```

代码仍保留逐字段覆盖能力，方便将来确有需要时使用。

### 4.7 VibeHub 房主浏览器代理大模型

VibeHub 已实现：

- 房主从自己的浏览器 preset 中为最多两个空位选择模型和策略。
- 房主浏览器运行 AI 决策，其他客户端不直接调用大模型。
- 大模型 Key、baseUrl 和内部 presetId 不进入公共座位身份。
- 房主广播带 `roomId + authorityEpoch + round + sequence` 的权威 `llm_message`。
- 每个客户端先按自己的座位视角转换消息座位，再显示气泡并调用公共 TTS 网关。
- AI 预留座位不会被后加入的真人占用。
- 当前控制器身份而非历史座位配置决定是否播放 AI 获胜语音，避免真人胡牌时误播 AI TTS。

关键文件：

- `src/game/online/vibe/vibeLlm.ts`
- `src/game/online/vibe/vibeLobby.ts`
- `src/game/online/vibe/vibeRoomSession.ts`
- `src/game/online/useVibeRemoteGame.ts`
- `src/components/lobby/RoomPanel.vue`

核心提交：

- `a06110e feat(vibehub): run room LLM seats in host browser`
- `82885f6 feat: share LLM seat identity and TTS gateway`
- `3cbffd8 fix: isolate LLM voice and local bubble seats`
- `3bc4a2c fix(vibehub): reserve LLM seats and isolate voices`

### 4.8 发言频率限制

单机、Python 多人和 VibeHub 多人均已加入确定性发言准入策略，防止上一圈语音尚未播完：

- 全桌普通吐槽最短间隔：4 秒。
- 话痨：同座位 6 秒。
- 激进：同座位 8 秒。
- 稳健：同座位 12 秒。
- 高冷：同座位 16 秒。
- 普通语音只读第一句，最多 16 个 Unicode 字符。
- 胡牌等 `important` 台词不受普通冷却拦截。

实现文件：

- `src/game/llm/speechPolicy.ts`
- `backend/app/llm/speech_policy.py`

相关提交：

- 前端 `176c1ca feat: throttle LLM table speech`
- VibeHub `ad12216 feat(vibehub): throttle hosted LLM speech`
- 后端 `92da4ec feat: throttle multiplayer LLM speech`

## 5. 三条调用链

### 5.1 单机

```text
浏览器规则引擎
  -> 浏览器本地 LLM preset 调用
  -> 本地候选校验与确定性回退
  -> 气泡
  -> POST /api/local-tts/synthesize
  -> 浏览器播放缓存 MP3，同时压低 BGM
```

### 5.2 `master` WebSocket 多人

```text
Python 权威房间
  -> 服务端 providerId 找到 LLM Key
  -> Python 调用 LLM、校验、回退
  -> 广播 llm_message 并写日志
  -> Python 百度 TTS 与缓存
  -> 广播 llm_audio
  -> 所有客户端按本地座位显示和播放
```

### 5.3 VibeHub P2P 多人

```text
房主浏览器权威规则引擎
  -> 房主本地 LLM preset 调用
  -> 房主校验、回退、发言节流
  -> 广播公开 llm_message（不含 Key/baseUrl）
  -> 各客户端转换为本地座位
  -> 各客户端显示气泡
  -> 各客户端调用 https://www.bestguo.top:58000 的 TTS 网关
  -> 后端缓存命中后返回同一 MP3
```

## 6. “只配置 TTS、不配置大模型 Key”是否可行

**可行。当前代码不会强制要求 Python 后端必须配置 LLM API Key 才能启动 TTS。**

- `backend/app/llm/config.py::load_llm_providers()` 在没有完整 LLM provider 时返回空字典。
- 此时 `llmAvailable=false`，房间不会提供服务端大模型座位，但普通规则 AI 和普通联机仍可工作。
- `backend/app/tts/config.py` 独立读取百度凭据。
- `LOCAL_TTS_ENABLED=auto` 会根据百度凭据是否可用决定单机网关是否启用。
- 如果客户端明确提交了 LLM 座位但服务端没有可用 provider，开局会拒绝该 LLM 配置；这不影响纯 TTS 网关。
- VibeHub 的大模型 Key 在房主浏览器，Python 服务器可以只部署 TTS。

最小 TTS-only 思路：

```ini
LLM_ENABLED=false
LOCAL_TTS_ENABLED=auto
BAIDU_TTS_API_KEY=...
BAIDU_TTS_SECRET_KEY=...
```

也可以继续使用已被 `.gitignore` 排除的 `backend/docs/百度api-key.txt`，但生产部署更建议使用环境变量或 Secret 管理。

## 7. 火山引擎方向：已评估，尚未实施

初步结论：火山引擎豆包语音合成大模型在自然度、上下文语气、角色音色和部分音色的情绪控制方面，比当前百度基础 TTS 更适合麻将 AI 短吐槽。但其产品线、鉴权、资源 ID、音色能力和计费入口比当前百度 REST 接口复杂。

建议的迁移方式不是删除百度实现，而是抽象 provider：

```text
TtsService
  |- VolcengineTtsProvider（优先）
  `- BaiduTtsProvider（失败降级）
```

第一版建议：

- 使用非流式 MP3，24 kHz；当前吐槽很短且已有磁盘缓存，暂不需要流式播放。
- 缓存键至少包含：provider、voiceType、emotion、emotionScale、speed、pitch、text 和缓存格式版本。
- 为激进、稳健、话痨、高冷从控制台实际支持列表选择 `voice_type`，不要编造音色 ID。
- 仅对明确支持情绪的音色发送 `emotion` / `emotion_scale`。
- 火山失败、超时、额度不足时回落到百度，并保留负缓存，避免一条失败文本反复请求。
- 音色克隆必须使用本人或已获得明确授权的声音素材，不应直接抓取 B 站创作者声音进行克隆。

官方参考：

- [语音合成大模型产品简介](https://www.volcengine.com/docs/6561/1257543?lang=zh)
- [语音合成大模型 API 参数](https://www.volcengine.com/docs/6561/2228192?lang=zh)
- [语音合成 SDK 概述](https://www.volcengine.com/docs/6561/79827?lang=zh)

## 8. 当前验证基线

### 8.1 前端单元测试

2026-08-23 执行：

```powershell
pnpm test
```

结果：

```text
Test Files  78 passed | 1 skipped (79)
Tests       648 passed | 2 skipped (650)
```

### 8.2 后端测试

普通运行受到本机两个环境问题污染：

- `C:/Users/He Guo/AppData/Local/Temp/pytest-of-He Guo` 无访问权限。
- HTTPX 继承本机 `socks5://127.0.0.1:58310` 代理，但虚拟环境未安装 `socksio`。

可复现的干净运行方式：

```powershell
$testTmp = 'D:/vueprojects/lianhua_guangma/tmp/pytest-backend'
New-Item -ItemType Directory -Force -Path $testTmp | Out-Null
$env:TEMP = $testTmp
$env:TMP = $testTmp
$env:HTTP_PROXY = ''
$env:HTTPS_PROXY = ''
$env:ALL_PROXY = ''
$env:NO_PROXY = '*'
backend/.venv/Scripts/python.exe -m pytest backend/tests -q `
  --basetemp "$testTmp/base" -p no:cacheprovider
```

本次全量结果：

```text
287 passed, 1 failed
```

唯一失败是 `test_lotus_legacy_two_clients_share_authoritative_opening` 的本机 WebSocket opening handshake 超时。随后用相同干净环境单独重跑该测试：

```text
1 passed in 16.36s
```

因此当前证据是“功能测试全部可通过，但全量串行运行仍观察到一次时序型握手偶发失败”，不应夸大成已经获得一次完整的 288/288 全绿记录。

### 8.3 建议继续做的线上验收

使用 2 真人 + 2 大模型，至少完整跑一场东风场，并检查：

1. 配置为 AI 的座位不会被第二名真人占掉。
2. 房主和客户端看到的 AI 昵称、头像、气泡座位一致。
3. 对家 AI 的气泡不会偏到下家。
4. 每个有声音的普通吐槽都有对应气泡；被节流的吐槽既不显示也不发声。
5. 真人胡牌不播放 AI TTS；AI 自摸或吃胡会播放重要 TTS。
6. 客户端刷新或 P2P 重连后不会把真人座位当作 AI。
7. 一圈内语音队列不会持续积压到下一圈。
8. 单次 LLM 决策最晚在 20 秒总预算后回退，不会卡住牌局。

## 9. 已知待办与建议顺序

1. **修正文档默认值**：`backend/README.md` 环境变量表仍写 `LLM_TIMEOUT_S=8`，代码和 `docs/llm-ai-design.md` 已经是 20 秒，应更新为 20。
2. **同步 Git 远端**：确认是否把本地 `master` 的 25 个提交推到 `origin/master`；确认是否把后端 2 个提交推到 `origin/main`。部署成功不等于源码远端已备份。
3. **检查生产 `.env` 音色层级**：删除不再需要的 provider 级 SPEED/PITCH/VOLUME，让四种策略参数真正生效。
4. **完成一次完整线上多人回归**：重点覆盖座位预留、不同客户端的相对座位气泡、真人/AI 身份和胡牌 TTS。
5. **决定是否接入火山引擎**：若确认，先抽象 TTS provider，再接非流式 MP3 和百度降级；不要直接把百度类改名硬替换。
6. **处理两份未跟踪 E2E 文件**：先审查内容，再由用户决定提交或删除，禁止顺手覆盖。
7. **后端完整全绿基线**：在干净环境再跑一次全量，确认 WebSocket 握手偶发项是否重复出现。

## 10. 接手时容易踩的坑

- 不要把 `backend/` 当成前端仓库子目录提交；它是独立 Git 仓库。
- 不要在 `vibehub` 直接修改应该从 `master` 同步的共享 UI/规则文件。
- 不要将单机浏览器的大模型 Key 发给 Python 后端或 P2P 客户端。
- 不要把 `backend/docs/百度api-key.txt`、`.env` 或控制台 Token 写进日志、测试快照或本文。
- 修改任何音色、语速、音调、音量、情绪、provider 或编码格式后，都要改变缓存键或缓存版本，否则会继续听到旧 MP3。
- VibeHub 消息中的座位是权威全局座位，展示气泡和播放空间音频前必须转换为当前客户端的本地座位。
- “这个座位曾经配置过 AI”不能作为播放 AI TTS 的依据；必须以当前控制器/当前公开座位身份为准。
- 原生音效、报牌语音和模型 TTS 是三条不同音频来源，修改时不要把出牌落桌声一并静音。
- 重要胡牌台词必须绕过普通吐槽冷却，但仍应避免同一事件被结算时间线重复触发。
- Python 后端可以 TTS-only；不要为方便启动而伪造空 LLM Key。

## 11. 关键提交索引

### 前端共享 / `master`

- `9f3888d`：单机与联机 LLM 配置分离
- `9644d52`：展示每个模型的全部策略
- `b9ea905`：多人 AI 气泡
- `3cc97c7`：放大 PC 气泡文字
- `e90913a`：联机播放后端 TTS
- `fd518e8`：保留 LLM 座位的出牌碰撞声
- `0f9afe9`：TTS 时压低 BGM
- `92c1e34` / `4941cd3`：共享单机 TTS runtime
- `a75fe67`：修复浏览器单机 TTS 播放
- `22f37d4`：机器人 emoji 改 SVG
- `82885f6`：共享 AI 座位身份与 TTS 网关信息
- `3cbffd8`：修复 AI 声音和本地气泡座位归属
- `176c1ca`：限制普通吐槽频率
- `75115e0`：LLM 决策预算改 20 秒

### VibeHub 专属

- `a06110e`：房主浏览器运行房间 LLM 座位
- `3bc4a2c`：AI 座位硬预留和声音身份修复
- `ad12216`：VibeHub 房主 LLM 发言节流
- `87efc23`：VibeHub LLM 决策预算改 20 秒

### Python 后端

- `6fcca70`：保护癞子、精牌不被 LLM 错误打出
- `2aceba9`：每座位策略覆盖
- `fb055b7`：广播并记录 LLM 吐槽与场次汇总
- `6e3bf95`：百度 TTS 与缓存
- `88b0340`：AI 胡牌 TTS
- `e58317e`：按 provider 配置 TTS 音色
- `7d49200`：独立单机 TTS 网关
- `8c360a8`：允许本地 TTS 网关来源
- `92da4ec`：Python 多人 LLM 发言节流
- `e3436c7`：后端 LLM 决策预算改 20 秒

## 12. 对话需求时间线（压缩版）

1. 评审并完善 `docs/llm-ai-design.md`。
2. 检查前端 Prompt 对两种莲花玩法的适用性，补充禁止七对等规则。
3. 分离单机和 Python 联机的大模型配置。
4. 修复后端 LLM 错打癞子、精牌。
5. 调整多人大厅 AI 选择 UI、暗色下拉框、展示模型全部策略。
6. 增加多人日志、AI 吐槽气泡、桌面文字大小和 SVG 机器人图标。
7. 设计并实现百度 TTS 的文本+音色缓存。
8. 增加按 provider 和策略的音色组合，处理声音偏小和 BGM 遮挡。
9. 增加单机独立 TTS，使 `master` 与 `vibehub` 都能使用。
10. 在 VibeHub 中由房主浏览器代理大模型，并要求至少两名真人开局。
11. TTS 网关改为 `https://www.bestguo.top:58000`。
12. 修复 AI 座位被真人占用、真人误播 AI 胡牌 TTS、客户端气泡错位。
13. 降低单机和多人 AI 发言频率，避免语音跨圈积压。
14. 将前后端 LLM 决策总预算统一改为 20 秒。
15. 确认 Python 后端支持只配置 TTS、不配置 LLM Key。
16. 评估火山引擎豆包语音合成大模型，暂定“火山主用、百度降级”为候选方向，尚未实施。

