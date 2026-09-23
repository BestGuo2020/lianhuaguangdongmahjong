# Jev AutoDL GPU 轮次记录（2026-09-23，进行中→结案）

前置：`jev-cpu-pilot-2026-09-23.md`（v1 拒绝）后用户拍板 AutoDL 自炼路线。实例：AutoDL 西北B vGPU-32GB（RTX 4080 SUPER 切片，¥1.58/时），torch 2.12.1+cu130，conda py3.12。预算纪律：实验段 ≤¥60 或 ≤8h（自 20:27 起算，硬停 04:27）。

## 一、零shot 基线（dev-v3 全量 858 条，GPU 实测）

| 模型 | accuracy | NLL | ECE |
|---|---:|---:|---:|
| Qwen2.5-7B-Instruct zero-shot | **19.3%** | 4.587 | 0.570 |
| Qwen2.5-1.5B-Instruct zero-shot | **23.7%** | 2.507 | 0.324 |
| （背景参考）1.5B + 温度校正（250 子采样口径） | 26.4% | 1.866 | 0.140 |

**7B 弱于 1.5B**——更大基座在本任务（中文麻将紧凑特征 + 闭集决策）上无优势且更过度自信。
副作用：E3（7B LoRA）门槛条件「E1 acc≥35%」直接不成立（19.3%），**该分支自动熄灭，预算未花**。

## 二、基础设施排障日志（同根因链，全部已修并提交）

1. **HF 直连 OSError**（数据中心 IP）→ 换 ModelScope 镜像下载至数据盘（`238e116`）。
2. **conda 不在非交互 PATH / 镜像无 tmux** → 脚本 source conda + nohup（`4c8f74e`）。
3. **上游 train_calibrated 内存炸弹**：全候选单批 × 全词表 logits.float()+log_softmax ≈ 39GB → 本地段错误与远端 OOM 同根因；vendored `train_calibrated_chunked.py`：逐候选行 forward + 目标位置 logsumexp（`2e1dc60`）。
4. **chunk 循环索引 bug**：把整行当候选段 → positions 越界 device-side assert（`2187813`）。
5. **logits 驻留 OOM**：advanced indexing / contiguous / clone 的 backward 均保留全宽 logits 存储引用（实测 ~4.9GB/chunk 驻留）→ **activation checkpoint 包 chunk forward**（no-grad 执行、backward 重算）为唯一结构性保证；峰值 16.3GB/32GB（`5d03fb6`）。
6. **步速预算**：chunk-rows=1 实测 5.1s/step → 7413 步 10.5h 超预算 → chunk-rows=4（forward 次数 ÷4，峰值瞬态 ~20GB 仍安全），epochs 2→1（偏离已记录）（`1f8475e`）。
7. **运维陷阱**：`pkill -f <pattern>` 的 pattern 出现在 ssh 会话自身 cmdline → 自杀（造成一次双编排并存）；括号正则 `[r]un-...` 规避。pwsh 管道按 CRLF 重编码远端脚本 → 一律走 scp 文件执行。vGPU 宿主机 load 17–19 时 ssh 会话偶发挂死 → 短超时重试。

## 三、E2 蒸馏与门槛判定（已过门）

配置（六轮 OOM/数学排障后的最终组合，见 §二 补充）：5d03fb6 逐行 checkpoint fn、rows=1、
train 子集 head-1200、1 epoch、bf16、brier 0.5；稳态 4.4s/step；训练 01:02–02:31（实例时间）。

| 模型（dev-v3 全量 858） | accuracy | NLL | ECE |
|---|---:|---:|---:|
| Qwen2.5-7B zero-shot | 19.3% | 4.587 | 0.570 |
| Qwen2.5-1.5B zero-shot | 23.7% | 2.507 | 0.324 |
| **LoRA-1.5B 蒸馏后（1200 样本 1 epoch）** | **70.6%** | **1.407** | 0.204 |
| 同上 + 温度校正 T\*=2.590 | 70.6%（argmax 不变） | **0.912** | **0.043** |

**门槛判定（预注册：acc≥0.50 且 NLL≤1.5）：0.7063 / 1.4066 → 通过**，取得 E4 资格。
orchestrator 独立 eval 与脚本内 eval 数字逐位一致（0.70629/1.40663/0.20391）✓。

解读：1200 样本单 epoch 把 teacher（本地 EV）一致率从 23.7% 拉到 70.6%；仍 29.4% 偏离
teacher——E4 将回答这 29.4% 是否集中在关键决策上（一致率≠分数 parity）。
校正把 ECE 从 0.204 压到 0.043：蒸馏模型的置信度也可用了（信号源方案的弹药 +1）。

## 四、E4 pilot（待日间会话）

夜间窗口 20:27–02:55 = 6.47h ≤ 8h 预算 ✓ 收在 ALL_STEPS_DONE；E4（hint 臂 N=30，
seeds 3000–3029，baseline 复用既有两轮数据）需 ~2–3h，超出夜间剩余预算，**留日间会话 +
新预算声明**后执行：实例上 `openjev serve --adapter /root/jev/ckpt/lora-1.5b-v3
--calibration /root/jev/calibration-lora.json`（实例保持开机待命，空闲 ¥1.58/h，
用户可从控制台关机止损）→ 本地 SSH 隧道 + `jev-selfplay-run.test.ts`（ARMS=hint,
MATCHES=30, SEED=3000）→ digest → 按预注册标准结案（≥+50 采用 / ≤−100 或 CI 上界<0 拒绝 /
其余不采用）。实例若被关机，模型/adapter/校准均在数据盘，重开即用。

## 五、边界与下一步

- 蒸馏是 teacher-on-policy（EV 轨迹 head-1200）：学生未见自己犯错后的局面分布；
  若 E4 拒绝而一致率信号仍值得救，下一轮用学生自轨迹补采（DAgger 式）再蒸。
- 7B 路线已熄（zero-shot 19.3% < E3 门槛 35%，且显存/时间更差）。
- 六轮训练实现排障根因清单（供后续复用，勿重踩）：① 候选段误取整行（positions 越界+垃圾
  loss）；② 非重入 checkpoint 保留前向图（rows>1 即 OOM）；③ KV-cache 半精度共享污染；
  ④ vGPU 无 flash-attn → math attention S² 反向保留；⑤ v4 hidden+split-vocab 在该 vGPU 上
  有无法解释的 ~30GB 常量分配（已弃）。最终可用组合 = 逐行 checkpoint + rows=1。
- 若 E4 拒绝：选项 4（Jev/蒸馏模型当危险度·置信信号源融合进 EV 策略）成为主路线——
  校正后 ECE 0.043 的置信度是该路线的关键前提，已具备。

## 六、E4 终判与半庄表演赛（日间会话）

**E4（hint 臂 N=30，seeds 3000–3029，baseline 同跑自闭环）**：配对差 mean **−296**、sd 1508、
bootstrap CI95 **[−841, +247]**、12/30 场为正；一致率（自轨迹）61.0%；拒胡 82 vs baseline 45；
Jev 请求失败 1、执行异常 0。预注册均值条款（≤−100）触发 → **拒绝采纳为独立 seat0 玩家**；
书面注明 CI 含 0（统计不显著、方向为负），若未来加样翻案需新预注册。
结论：蒸馏（1200 样本 1 epoch）远胜 zero-shot（23.7%→61% 一致率）但不足以独立成局；
主路线转选项 4（信号源融合）或蒸馏迭代（加数据/DAgger/2 epochs）。

**半庄表演赛（seed 20260924，Jev 蒸馏+校正 seat0 vs 本地 EV×3，8 局）**：Jev −6375 末位
（R1–R3 累 −7490 为主损失段，R4–R6 近乎打平，R7–R8 再失）；205 请求 0 失败。
完整对局数据已导出（用户要求）：`work/jev-match-hanchan-2026-09-23-19-41-21/`
- `match-analysis.json`（11.9MB 自包含分析包：2032 决策 / 1016 决策前态 / 264 结算 /
  8 复现 / 348 响应检查点，reproductionCapable=true）
- `match-replay.json`（8 局展示回放，可进应用回放导入器）
- `summary.json`（座位/分数/名次/逐局收支/Jev 请求统计）

日间 GPU 窗口 ≈0.6h（E4 16min + 表演赛 ~10min）。实例与隧道保持待命供复跑。

## 七、选项 4 信号源融合（止损阀已过，pilot 预注册）

**信号检验（work/jev-signal-*/metrics.json）**：n=547 个 seat0 弃牌决策（E4 30 场存档补问），
realizedRon 122（base rate 22.3%）；**AUC 0.716**；分桶实现率单调 9.5%→21.3%→58.6%
（[0.3,0.4)/[0.4,0.5)/[0.5,0.6)）；中 bands 过度自信（meanP 0.43 vs 实现 0.21）→
融合用 λ 加权重排而非原始概率阈值。预注册 kill 阀：AUC≤0.55 杀、≥0.60 进 pilot → **PROCEED**。

**融合 pilot 预注册（跑前写死）**：
- 臂：`fusion`（seat0 = ev-jev-fusion）vs `baseline`（纯 EV），N=30，**seeds 4000–4029**（未用过）；
- 融合规则：fusionScore(c) = evIncome(c) − **400**·pDanger(c)，仅在弃牌候选间重排；
  EV 最优为非弃牌动作、或 Jev 查询失败 → 保持 EV 原选择（失败回退记 attempt fallback）；
  pDanger = 单请求多 noul（每弃牌候选一问）；
- 结案标准沿用预注册阈值（≥+50 采用 / ≤−100 或 CI 上界<0 拒绝 / 其余不采用）；
- 预算：新窗口 ≤2h / ¥10；超限停机报告。
