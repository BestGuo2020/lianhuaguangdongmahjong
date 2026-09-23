#!/usr/bin/env bash
# 远端实验编排（AutoDL 实例上、tmux 内一次跑完）：
#   bash /root/jev/run-experiments.sh
# 顺序：合并训练集 → E2a 冒烟 → E1(7B zero-shot) → E1b(1.5B zero-shot) → E2(LoRA 蒸馏)
#       → E2 评估（门槛判定依据）→ 温度校正。门槛判定与 E3/E4 决策由代理读日志后做，脚本不越权。
# 日志：/root/jev/logs/{run.log, e2a.log, e1-7b.json, e1b-1.5b.json, e2-train.log, e2-eval.json, e2-cal.log}
# 纪律：set -e 任一步失败即停（GPU 空转也是钱）；每步带时间戳进 run.log 供预算记账。
set -euo pipefail
export HF_HOME=/root/autodl-tmp/hf
# 基座走 ModelScope 下载的本地目录（HF 直连在数据中心 IP 实测失败）
MODEL15=/root/autodl-tmp/models/Qwen2.5-1.5B-Instruct
MODEL7=/root/autodl-tmp/models/Qwen2.5-7B-Instruct
# AutoDL 的 conda 只在交互 shell 进 PATH；nohup 非交互运行必须手动 source
if ! command -v python >/dev/null 2>&1; then
  source /root/miniconda3/etc/profile.d/conda.sh
  conda activate base
fi
cd /root/OpenJev
LOG=/root/jev/logs
mkdir -p "$LOG" /root/jev/ckpt
ts() { date '+%F %T'; }
step() { echo "[$(ts)] == $1 ==" | tee -a "$LOG/run.log"; }

step PREP-MERGE
if [ ! -f /root/jev/train-v3-all.jsonl ]; then
  cat /root/jev/train-v3.jsonl /root/jev/train-v3-ext.jsonl > /root/jev/train-v3-all.jsonl
fi
wc -l /root/jev/train-v3-all.jsonl | tee -a "$LOG/run.log"   # 期望 7413

step E2A-SMOKE   # 训练循环机制验证（本地 Windows/CPU 段错误，只能在此验证）；不过不进 E2
head -n 100 /root/jev/train-v3-all.jsonl > /root/jev/train-smoke.jsonl
python /root/jev/train_calibrated_chunked.py --model "$MODEL15" \
  --data /root/jev/train-smoke.jsonl --output /root/jev/ckpt/smoke \
  --epochs 1 --max-steps 3 --grad-accum 1 --max-len 4096 --dtype bfloat16 \
  2>&1 | tee "$LOG/e2a.log"

step E1-7B-ZEROSHOT
openjev eval -m "$MODEL7" --dtype bfloat16 \
  --data /root/jev/dev-v3.jsonl 2>&1 | tee "$LOG/e1-7b.json"

step E1B-1.5B-ZEROSHOT
openjev eval -m "$MODEL15" --dtype bfloat16 \
  --data /root/jev/dev-v3.jsonl 2>&1 | tee "$LOG/e1b-1.5b.json"

step E2-LORA-1.5B   # 7413 条全量 2 epochs；max-len 4096（2048 会静默丢 19-26% 样本）
#   --grad-accum 1 是显存口径：单样本 autograd 图（分块 logits+中间量）≈15GB，accum=2
#   同时驻留两样本图 → 30GB OOM（实测）；accum=1 每样本 backward 后释放，总 forward 量
#   不变（步数×每步样本守恒），仅更新频率变化（蒸馏可接受，偏离已记录）。
python /root/jev/train_calibrated_chunked.py --model "$MODEL15" \
  --data /root/jev/train-v3-all.jsonl --eval-data /root/jev/dev-v3.jsonl \
  --output /root/jev/ckpt/lora-1.5b-v3 --epochs 2 --max-len 4096 --brier-weight 0.5 \
  --grad-accum 1 \
  2>&1 | tee "$LOG/e2-train.log"

step E2-EVAL-LORA   # 门槛判定依据：accuracy>=0.50 且 NLL<=1.5 才进 E4
openjev eval -m "$MODEL15" --adapter /root/jev/ckpt/lora-1.5b-v3 \
  --dtype bfloat16 --data /root/jev/dev-v3.jsonl 2>&1 | tee "$LOG/e2-eval.json"

step E2-CALIBRATE   # 给「基座+LoRA」组合拟合温度（--adapter 必带，校到基座头上是张冠李戴）
python /root/jev/openjev-fit-calibration.py --device cuda \
  --model "$MODEL15" --adapter /root/jev/ckpt/lora-1.5b-v3 \
  --train /root/jev/train-v3-all.jsonl --dev /root/jev/dev-v3.jsonl \
  --train-limit 800 --dev-limit 0 --sample-seed 7 \
  --cache-dir /root/jev/cache-gpu --output /root/jev/calibration-lora.json \
  --metrics /root/jev/metrics-lora.json 2>&1 | tee "$LOG/e2-cal.log"

echo "[$(ts)] ALL_STEPS_DONE" | tee -a "$LOG/run.log"
