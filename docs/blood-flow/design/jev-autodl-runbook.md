# AutoDL GPU 路线 Runbook（OpenJev LoRA 蒸馏 + 快速 pilot）

前置决策：用户拍板走 AutoDL 自炼路线（2026-09-23），不做官方 Jev API 对比。本文档是远端操作的唯一口径；预注册门槛与预算写死在 §3/§6，跑之前不改。

## 0. 角色分工

- **用户**：注册 AutoDL（实名+充值 ¥50–100）、租机、把本仓库生成的 SSH 公钥加进控制台、把实例 ssh 指令发给代理。
- **代理**：上传数据/脚本 → 远端 E1/E2（/E3）→ 门槛判定 → SSH 隧道 + 本地 pilot → 拉回产物 → 结案记录。
- **凭据纪律**：私钥在本地 `~/.ssh/autodl_jev`（永不入库）；实例密码只在用户↔控制台之间，代理不落盘不落日志。

## 1. 实例规格与镜像

- GPU：**RTX 4090 24GB 优先，3090 24GB 亦可**（按时计费；两台都够 1.5B 全量 LoRA 与 7B 推理；7B LoRA bf16 在 24GB 上贴边，用子集+max-len 4096 控制显存）。
- 镜像：基础镜像选 **PyTorch 2.x（≥2.1）/ CUDA 12.x / Python ≥3.10**。
- 数据盘默认即可（模型缓存 ~20GB + 产物 <1GB）。
- 区域：有货即可（国内区域对本机延迟无感——瓶颈在推理不在网络）。

## 2. SSH 公钥与连通

本机已生成专用密钥对（ed25519，注释 `jev-autodl`）。用户把公钥粘贴到 AutoDL 控制台「账号设置 → SSH 公钥」（对全部实例生效），或在实例里 `echo '<pubkey>' >> ~/.ssh/authorized_keys`。之后代理用：

```powershell
ssh -i $env:USERPROFILE\.ssh\autodl_jev -p <端口> root@<host>   # 非交互执行
scp -i $env:USERPROFILE\.ssh\autodl_jev -P <端口> <本地文件> root@<host>:<远端路径>
```

## 3. 上传清单（本地 → 实例 /root/jev/）

| 文件 | 用途 |
|---|---|
| `work/jev-calibration/train-v3.jsonl`（1821 行） | 训练集 A |
| `work/jev-calibration/train-v3-ext.jsonl`（seeds 1030–1089） | 训练集 B（合并后 ~7k 行） |
| `work/jev-calibration/dev-v3.jsonl`（858 行） | **唯一裁判集**（不参与任何拟合；模型选择用它即视为轻度复用，已记录） |
| `scripts/openjev-fit-calibration.py` | GPU 版温度校正+评估（`--device cuda`） |
| `scripts/autodl/setup-openjev.sh` | 一键装环境 |

远端合并：`cat train-v3.jsonl train-v3-ext.jsonl > train-v3-all.jsonl`

## 4. 远端实验序列（命令即口径）

```bash
cd /root/OpenJev && source /etc/network_turbo 2>/dev/null || true

# E1：7B zero-shot 在 dev 上的成绩单（对照 1.5B-校准版：acc 26.4% / NLL 1.866 / ECE 0.140）
openjev eval -m Qwen/Qwen2.5-7B-Instruct --dtype bfloat16 --data /root/jev/dev-v3.jsonl

# E1b：1.5B zero-shot 全量 dev（858 条）——与 E2 LoRA 同口径的参照系
#      （此前的 26.4%/1.866 是 250 条子采样 + 温度校正后的数字，口径不同，只作背景参考）
openjev eval -m Qwen/Qwen2.5-1.5B-Instruct --dtype bfloat16 --data /root/jev/dev-v3.jsonl

# E2a（远端 5 分钟冒烟，必做勿跳）：训练循环在本地 Windows/CPU 上段错误（0xC0000005，
#   与数据无关——数据管线已在本地用真实 tokenizer 验证 5/5：gold 索引/候选数/长度全对），
#   训练机制只能在目标 GPU 环境验证；冒烟不过就地排查，不进 E2。
head -n 100 /root/jev/train-v3-all.jsonl > /root/jev/train-smoke.jsonl
python scripts/train_calibrated.py --model Qwen/Qwen2.5-1.5B-Instruct \
  --data /root/jev/train-smoke.jsonl --output /root/jev/ckpt/smoke --epochs 1 --max-steps 3 \
  --grad-accum 2 --max-len 4096 --dtype bfloat16
# 预期输出：trainable params 行、"100 training decisions"、3 条 step loss、saved LoRA adapter

# E2：LoRA 蒸馏 1.5B（train 全量 7413 条，2 epochs）
#   --max-len 必须 ≥3072：v3 样本实测 token 长度 p50≈1.9k / p95≈2.2k / max 2464
#   （scripts/openjev-token-probe.py，2026-09-23 实测），默认 2048 会**静默跳过 19–26% 样本**；
#   4096 全覆盖且留余量（该参数只做过滤不做 padding，放大无计算代价）。
#   brier 0.5 按 OpenJev README 推荐（NLL+Brier 同时压，兼顾准确率与校准）。
python scripts/train_calibrated.py --model Qwen/Qwen2.5-1.5B-Instruct \
  --data /root/jev/train-v3-all.jsonl --eval-data /root/jev/dev-v3.jsonl \
  --output /root/jev/ckpt/lora-1.5b-v3 --epochs 2 --max-len 4096 --brier-weight 0.5

# E2 评估（训练脚本尾部也会打 eval，这里用统一口径再跑一次并留档）
openjev eval -m Qwen/Qwen2.5-1.5B-Instruct --adapter /root/jev/ckpt/lora-1.5b-v3 \
  --dtype bfloat16 --data /root/jev/dev-v3.jsonl

# E3（条件触发：E2 未达标且 E1 acc≥35% 且预算余量>3h）：7B LoRA 子集训练
#   ⚠️ 显存口径（2026-09-23 本地冒烟实测教训：train_calibrated 把**一个样本的全部候选**
#   （12–16 个 × ~2k token）打成单批 forward+backward——1.5B bf16 在 24GB 上 ~11GB 没问题；
#   7B bf16 ≈ 权重 15GB + 激活 ~18GB 必 OOM（本地 fp32 宽批直接段错误 0xC0000005）。
#   对策（按序）：① 训练前给 model 开 gradient_checkpointing（实例上 python -c 一行补丁或
#   sed 注入 train_calibrated.py 的 model.config.use_cache=False 之后：
#   `model.gradient_checkpointing_enable()`，激活省 ~70%、慢 ~30%）；
#   ② 仍 OOM → 放弃 E3 如实记录——**不许**拆候选分批（joint softmax 损失要求全候选同批，
#   拆批会改变损失语义，产物就不是"蒸馏"了）。
#   head -n 2500 /root/jev/train-v3-all.jsonl > /root/jev/train-sub.jsonl
#   python scripts/train_calibrated.py --model Qwen/Qwen2.5-7B-Instruct \
#     --data /root/jev/train-sub.jsonl --eval-data /root/jev/dev-v3.jsonl \
#     --output /root/jev/ckpt/lora-7b-v3 --epochs 1 --max-len 4096 --brier-weight 0.5

# 达标后：给胜出模型重新拟合温度（GPU 上分钟级；dev 全量 858）
#   ⚠️ 必须带 --adapter：校正对象是「基座+LoRA」的组合，不带就校到基座头上（张冠李戴）
python /root/jev/openjev-fit-calibration.py --device cuda \
  --model Qwen/Qwen2.5-1.5B-Instruct --adapter /root/jev/ckpt/lora-1.5b-v3 \
  --train /root/jev/train-v3-all.jsonl --dev /root/jev/dev-v3.jsonl \
  --train-limit 800 --dev-limit 0 --sample-seed 7 \
  --cache-dir /root/jev/cache-gpu --output /root/jev/calibration-lora.json \
  --metrics /root/jev/metrics-lora.json
# 注意：--dev-limit 0 = dev 全量；E3 胜出时 --model/--adapter/缓存目录相应换成 7B 的
```

## 5. 预声明门槛（跑之前写死）

- **进 E4（pilot）条件**：胜出配置在 dev-v3 上 `accuracy ≥ 0.50` 且 `NLL ≤ 1.5`（对照：1.5B-zero-shot-校准版 26.4%/1.866；蒸馏若连 50% 都不到，说明 1.5B 容量或数据量不够，pilot 必然重演拒绝，不值 GPU 时长）。
- E1 的 7B zero-shot 成绩单独记录（回答"更大基座 zero-shot 有没有质变"），不单独作为进 E4 的依据——E4 用**校准后**的胜出模型。
- 不达标：拉回全部日志与 metrics，结案「蒸馏路线在当前数据/容量下不成立」，给下一步选项（扩数据到 3 万条 / 7B 全量 / 信号源方案），**不擅自放宽门槛**。

## 6. 预算与关机纪律

- GPU 租用累计 **≤ ¥60 或 ≤ 8 小时**（先到为准）；每个实验步骤结束立刻核对已用时长。
- 参考耗时（4090）：setup+下载 ~20min；E1 ~20min；E2 训练 ~1.5–3h；温度拟合 ~15min；E3 ~2–3h（子集）。
- 超限即停：保存产物 → 关机 → 如实报告进度与差额。
- AutoDL「无卡模式」（¥0.1/h）只用于传文件/装环境；训练评估必须 GPU 计费模式。

## 7. E4：pilot（远端 serve + 本地 runner，SSH 隧道）

```powershell
# 实例上（tmux/nohup 里跑，防掉线）：
openjev serve -m Qwen/Qwen2.5-1.5B-Instruct --adapter /root/jev/ckpt/lora-1.5b-v3 `
  --calibration /root/jev/calibration-lora.json --dtype bfloat16 --host 127.0.0.1 --port 8300

# 本地隧道（另开窗口挂着）：
ssh -i $env:USERPROFILE\.ssh\autodl_jev -CNg -L 8300:127.0.0.1:8300 -p <端口> root@<host>

# 本地 pilot（与 cpu-pilot-v3 完全同参，仅换 backend 标签；baseline 复用 seeds 3000-3009 已有数据，
# 但扩样教训在前——本轮直接 N=30：seeds 3000-3029，hint 臂跑满，baseline 若缺 3010-3029 则补跑）：
$env:JEV_SELFPLAY_RUN='1'; $env:JEV_SELFPLAY_TAG='gpu-lora-pilot'; $env:JEV_SELFPLAY_ARMS='hint,baseline'
$env:JEV_SELFPLAY_MATCHES='30'; $env:JEV_SELFPLAY_SEED='3000'
$env:JEV_BASE_URL='http://127.0.0.1:8300'; $env:JEV_BACKEND='openjev-qwen2.5-1.5b-lora-v3-cal'
node node_modules/vitest/vitest.mjs run --dir scripts jev-selfplay-run.test.ts
```

结案口径沿用设计文档 §4（含 N≥30 方差条款）：配对差 ≥+50 且回退率<5% → 采用；≤−100 或 CI 上界<0 → 拒绝；其余 → 不采用。

## 8. 产物回传清单（scp → work/jev-calibration/autodl/）

- `ckpt/lora-1.5b-v3/`（tar 后 ~50–200MB；7B adapter 另计）
- `calibration-lora.json`、`metrics-lora.json`
- E1/E2/E3 的 eval 输出（终端 JSON 留档成 `.json`）
- 训练日志（loss 曲线段）

回传后本地即可 `openjev serve --adapter`（CPU 也能跑蒸馏模型，只是慢——正式批量仍走 GPU）。
