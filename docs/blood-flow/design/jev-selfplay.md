# Jev 无头自对弈流水线（血流）：设计、A/B 协议与 OpenJev CPU 部署

状态：里程碑 1 已实现（客户端 / 序列化 / 无头运行器 / 确定性摘要）；真实 OpenJev 部署与正式 A/B 批次按本协议执行。

## 1. 背景

[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) 是 TypeSafe AI 的「System One」模型：不生成文本，对 `state` + 类型化 `questions` 返回**封闭候选集合上的概率分布**（`choice` ≤255 项 / `noul` 是非 / `score` 分级），响应快、输出不会越出 schema。开源线兼容实现 [OpenJev](https://github.com/GitHub30/OpenJev)（MIT，任意 HF instruct 模型 + torch，`POST /v1/systemone`）；另有 [jev_local](https://github.com/Argos1111/jev_local)（llama.cpp，Windows 需 WSL2，且 ModernBERT/Sarashina 后端为日语调校——**不用于本项目的中文牌局文本**）。

用途定位（本项目）：

- Jev 当**被测大脑**：在无头自对弈里替代 chat LLM 做候选选择，概率分布提供 chat 模型给不了的置信信号。
- 大模型当**赛后分析师**：只消费摘要与标记窗口，不上桌。
- 基线始终是本地 EV 策略（`decideBloodFlowActionEv` + `BLOOD_FLOW_LLM_AI`）：Jev 是否值得接入以配对差说话，不预设它更强。

## 2. 组件与数据流

| 文件 | 职责 |
|---|---|
| `src/game/llm/jevClient.ts` | `/v1/systemone` 客户端：请求构造、超时/额度/网络错误归并进 `LlmClientError` 分类、白名单校验、概率分布透传；`testJevConnection` 供设置页探测 |
| `src/game/llm/jevBloodFlowInput.ts` | 血流决策 → Jev 请求材料：state（规则文本 + 公开快照，两臂一致）、criteria（blind=仅动作名 / hint=附 `candidateLine` 特征行）、模板 id `jev-bf-{mode}-v1`；**engineSuggestion 不进请求** |
| `scripts/jev-selfplay.ts` | 无头运行器：Node 直驱 `BloodFlowEngine`（虚拟时钟、`paced` 关闭、`recordCommands` 开启），四座可配 `jev-blind`/`jev-hint`/`ev`/`heuristic`；进程内挂 `AnalysisRecorder`（内存 storage 驱动）+ 展示回放采集；产出 `buildAnalysisExport` 自包含分析包 |
| `scripts/jev-selfplay.test.ts` | 冒烟（mock HTTP 端点）：守恒、记录形状、回退链、确定性 |
| `scripts/jev-selfplay-run.test.ts` | 批量运行（`JEV_SELFPLAY_RUN=1` 门控）：三臂同种子列，落盘 `work/jev-selfplay/<run-id>/` |
| `scripts/analyze-jev-selfplay.mjs` | 确定性摘要：账本校验、来源/执行分布、拒胡盘点、EV 一致率、置信分桶、配对差、标记窗口 → `digest.json` + `digest.md` |

数据流：`runJevSelfplayMatch` → 分析包 JSON（每场一份）→ `analyze-jev-selfplay.mjs` → digest + flagged → （人工/大模型按 `blood-flow-ai` 技能复盘；疑点窗口可再跑 `scripts/blood-flow-counterfactual.ts` 量化损失）。

关键记录口径：

- Jev 概率分布存在每条 llm attempt 的 `answer.value.note`（JSON 字符串：`{probabilities, confidence, extras}`）——这是 Jev 回答的实体，不是内部思考。
- 请求失败 → `fallback {reason, strategy:'ev'}`，决策来源归 `model-fallback`；单候选窗口 → `rule-auto`，**不造 attempt**。
- 执行回执在窗口解决后判定；弃牌被胡转移出牌河时如实记 `executed` + 明细（不是 `state-changed`）。
- 复现数据与生产同形状（初始牌墙 + 四家初始手牌 + 完整命令含 `legalActionId`），分析包 `reproductionCapable` 必须为 true 才算有效场次。

## 3. 运行命令

```powershell
# 冒烟（不需要任何端点）
node node_modules/vitest/vitest.mjs run --dir scripts jev-selfplay.test.ts

# 批量（先起 OpenJev，见 §5；三臂 = blind,hint,baseline）
$env:JEV_SELFPLAY_RUN='1'; $env:JEV_SELFPLAY_TAG='cpu-pilot'
$env:JEV_BASE_URL='http://127.0.0.1:8300'; $env:JEV_BACKEND='openjev-qwen2.5-1.5b-cpu-bf16'
$env:JEV_SELFPLAY_MATCHES='10'; $env:JEV_SELFPLAY_SEED='1000'
$env:JEV_SELFPLAY_TIMEOUT_MS='18000000'
node node_modules/vitest/vitest.mjs run --dir scripts jev-selfplay-run.test.ts

# 摘要
node scripts/analyze-jev-selfplay.mjs work/jev-selfplay/<run-id>
```

## 4. A/B 预注册协议（本次批次的结案标准，先写死后跑）

- **对照**：`blind` / `hint` / `baseline` 三臂共用同一种子列（同牌墙同开局）；被测座位恒为 seat0，其余三座同一本地 EV 策略。每场 1 局、每臂 N 场，**每场是一个样本点**（同场窗口不独立、不跨场相加收益差）。
- **种子分区**：调参/试跑用 1000–1999；正式验收必须用未参与过任何调整的种子（5000 起）。不得复用已看过的回放当独立留出。
- **预算规则（CPU 现实）**：正式跑之前先在真实 OpenJev 端点上测单决策延迟（≥20 个真实决策请求，记 p50/p95）；每臂场数 N = 可接受总时长 ÷（p95 × 每场 jev 决策数 + 每场本地开销 ~20s）。延迟没测之前不定 N，**不用 mock 延迟冒充真实延迟**。
- **方差下限（2026-09-23 修订，v3 扩样实测教训）**：单场配对差 sd≈1400 点，N=10 的批次 se≈450——**结案批次每臂 N≥30 对，或 ROUNDS≥4 的多局场压方差**；N=10 只允许冒烟/延迟探针，不允许触发采用/拒绝条款。首批+扩样合并判定时，扩样必须预声明（场数、种子段、合并口径、不再扩样）。
- **主指标**：seat0 每场净分（配对差 arm − baseline 的均值 + bootstrap 95% CI）。
- **副指标**：seat0 名次、胡牌次数、放炮次数、EV 一致率、置信分桶一致率、拒胡数、Jev 失败/回退率、单决策延迟。
- **结案标准（本批次）**：
  - 采用（进入上桌评估阶段）：配对差均值 ≥ +50 点，且回退率 < 5%，且账本失配 = 0；
  - 拒绝：配对差均值 ≤ −100 点，或 CI 上界 < 0；
  - 其余：证据不足——要么按预算规则加样一次（预先声明加样上限），要么结案为「不采用」。
  - 一致率与校准分桶只做解释用，不单独作为采用依据（一致 ≠ 正确）。
- **诚实边界**：本流水线验证的是「Jev 在血流候选选择上的表现」；mock 端点通过 ≠ 真实模型更强；无头通过 ≠ 浏览器牌桌链路可用（上桌另走 e2e/设置面板里程碑）。

## 5. OpenJev CPU 部署（本机无独显；Intel NPU 不适用）

Intel AI Boost NPU 走 OpenVINO 栈，OpenJev 是 torch + HF transformers 栈，**没有现成 NPU 路径**；按 CPU 推理部署，基座选小模型。

**实际部署记录（2026-09-23，本机已按此装好）**：`D:\vueprojects\OpenJev`，Python 3.12.9 venv + `torch 2.14.0+cpu`（`--index-url https://download.pytorch.org/whl/cpu` 避开 CUDA 轮子）+ `pip install -e ".[hf,server]"`；基座 `Qwen/Qwen2.5-1.5B-Instruct`（HF 直连下载，缓存于 C 盘）；服务命令：

```powershell
cd D:\vueprojects\OpenJev
.venv\Scripts\openjev.exe serve --model Qwen/Qwen2.5-1.5B-Instruct --host 127.0.0.1 --port 8300 --dtype bfloat16
```

- 端口用 **8300**：8000 与 e2e 的 backend uvicorn 默认端口冲突。只绑 127.0.0.1，不暴露局域网。
- 冒烟：`Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8300/v1/systemone -ContentType 'application/json' -Body '{"state":"ping","model":"jev-latest","questions":{"ping":{"type":"noul","instructions":"Is this a connection test?"}}}'`
- 未设 `OPENJEV_API_KEY` 则不校验 Bearer；客户端空 key 不发 Authorization 头。
- CORS 只影响浏览器直连（未来上桌里程碑处理：vite proxy 或后端 `llm_relay.py` 转发）；无头 Node 不受影响。

### 实测性能（2026-09-23，Intel Core Ultra 5 225H，14C/14T，CPU 推理）

延迟探针：seed 9000 单场 blind 臂（26 个真实决策请求，state ≈1.5–2k tokens，criteria ≈12 项）：

| dtype | p50 | p95 | 失败 | 单场总耗时 |
|---|---:|---:|---:|---:|
| float32 | 11.9s | 12.3s | 0 | ~322s |
| bfloat16（采用） | 11.0s | 12.2s | 0 | ~302s |

- bf16 仅快 ~7%（该负载未见 AMX 级收益），仍采用 bf16；瓶颈是**每请求重新 prefill state**（规则文本占大头），OpenJev 只在单请求内共享前缀 KV，跨请求无缓存。
- 本地开销（引擎 + EV 候选层 + 记录）仅 ~10s/场：Jev HTTP 占单场耗时 ~97%。
- **预算规则落地**：单场 blind/hint ≈ 5–6 分钟 → cpu-pilot 预算 ~3h → **N=10/臂**（seeds 1000–1009，tag `cpu-pilot`，属试跑档）；正式验收另跑（N≥20、seeds 5000+、可通宵）。
- 提速选项（均未实施；改动即升模板版本或换 backend 标签）：state 规则文本瘦身、`Qwen2.5-0.5B-Instruct` 基座、`--system-prompt` 外置规则、更长 state 复用（需 OpenJev 侧跨请求缓存）。
- 探针单场观察（**1 场样本，不构成任何结论**）：blind seat0 净分 −3060、17 次放炮、0 胡、EV 一致率 34.6%、平均 confidence 0.33、2 处高置信分歧标记。

### 校正飞轮（第一轮已实现，2026-09-23）

- **gold 采集**：`scripts/jev-selfplay-collect.test.ts`（门控 `JEV_SELFPLAY_COLLECT=1`）——四座全 EV 跑局，每个 ≥2 候选且有 `engineSuggestion` 的决策点落一行 OpenJev 格式 `{state, questions:{action}, gold:{action}}` 到 `work/jev-calibration/<tag>.jsonl`（含 manifest）。样本与 pilot 请求**同源构造**（同一个 `buildJevBloodFlowRequest`），模板漂移即校准数据失效。产物规模：~91 样本/场（train 20 场=1821 行，dev 10 场=858 行，claim 行占 ~20%）。
- **温度校正**：`scripts/openjev-fit-calibration.py`（用 OpenJev 的 venv 跑）——单遍评分缓存 logprobs（断点续跑），train 黄金分割拟合 choice 温度，dev 在同一份缓存上给 T=1 与 T* 两组 accuracy/NLL/ECE（温度缩放不改 argmax，accuracy 前后相同）。不用 CLI `calibrate`+`eval` 是因为它们要 3 遍评分（CPU 上每遍数小时）。产物：`calibration-v3.json`（`openjev serve --calibration` 直接可用）+ `metrics-v3.json`。
- **模板 v3**（2026-09-23）：v2 质检发现 claim 窗口错发出牌指令（`request` 顶层没有 `decision` 字段，真实来源是 `request.state.decision`；单测夹具手写了该字段所以没拦住）。v3 修复并在自对弈冒烟里加了**集成回归**（真实决策输入 → collect 的 claim 行必须带 claim 指令）。v2 采集数据作废，`*-v3` 重采。
- **后续轮次**：LoRA 微调（`scripts/train_calibrated.py`，CPU 不现实，需 GPU）；DAgger 式迭代采集（用 Jev 自己的轨迹补采状态分布偏移）；gold 不只用 engineSuggestion（大模型复盘修正过的窗口回流）。

## 6. 已知限制

- Jev/OpenJev 是通用判断模型，不是麻将专用策略（Mortal/Suphx 是日麻专用且权重不开放/不可得）；裸牌力以 A/B 实测为准。
- 一致率对标 `engineSuggestion`（本地 EV 推荐），不是「正确动作」；真校准需对标记窗口跑反事实。
- `large-payment` 标记阈值固定 −200 点，未按番型语境归一。
- 引擎时钟为虚拟时钟（每次提交 +1s，`decisionMs` 放宽）；attempt timing 是真实单调时钟。虚拟时钟只影响记录里的时间戳语义，不影响规则（从不 expire）。
- 展示回放由每提交一次的旁观视角采样折叠而成：与浏览器生产路径同一折叠器（`recordBloodFlowView`），摸牌检测同为 best-effort 口径。
- 每臂默认单局/场；多局携分场（`JEV_SELFPLAY_ROUNDS>1`）已支持，但配对差口径按场计算，跨局 carryover 会放大方差。

## 7. 后续里程碑（记录用，未实现）

1. 真实 OpenJev 冒烟 + 延迟测定 → 按 §4 跑正式 A/B → 出结案记录（`docs/blood-flow/records/`）。
2. 上桌：`providerType: 'jev'` 进设置面板 + 浏览器 CORS 转发 + `blood-flow.llm.spec.ts` 式 e2e（mock 端点）。
3. 校正飞轮：gold 数据集生成脚本 + `openjev calibrate`/LoRA。
4. 标记窗口 → `blood-flow-counterfactual` 批量量化 → 大模型复盘报告模板。
