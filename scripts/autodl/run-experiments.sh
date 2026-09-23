#!/usr/bin/env bash
# 远端实验编排（AutoDL 实例上 nohup 后台一次跑完）：
#   nohup bash run-experiments.sh > exp-nohup.out 2>&1 &
# 顺序：PREP → E2a 冒烟 → E1(7B zero-shot) → E1b(1.5B zero-shot) → E2(LoRA 蒸馏)
#       → E2 评估（门槛依据）→ 温度校正。日志 /root/jev/logs/，set -e 失败即停。
# 门槛判定与 E3/E4 决策由代理读日志后做，脚本不越权。
# 显存/时间保守组合（六轮 OOM 实测后）：rows=2 + fp16（峰值 ~14GB）+ 子集 2500
# （2.5s/step ×1.5 争用余量 → 03:10-04:05 完成，硬停 04:27）。
set -euo pipefail
export HF_HOME=/root/autodl-tmp/hf
# AutoDL 的 conda 只在交互 shell 进 PATH；nohup 非交互必须手动 source
if ! command -v python >/dev/null 2>&1; then
  source /root/miniconda3/etc/profile.d/conda.sh
  conda activate base
fi
# 基座为 ModelScope 下载的本地目录（HF 直连在数据中心 IP 实测失败）
MODEL15=/root/autodl-tmp/models/Qwen2.5-1.5B-Instruct
MODEL7=/root/autodl-tmp/models/Qwen2.5-7B-Instruct
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
head -n 1200 /root/jev/train-v3-all.jsonl > /root/jev/train-sub1200.jsonl
wc -l /root/jev/train-sub1200.jsonl | tee -a "$LOG/run.log"

step E2A-SMOKE   # 宽样本 3 步冒烟（数学+显存门控）；不过不进 E2
head -n 100 /root/jev/train-v3-all.jsonl > /root/jev/train-smoke.jsonl
python /root/jev/train_calibrated_chunked.py --model "$MODEL15" \
  --data /root/jev/train-smoke.jsonl --output /root/jev/ckpt/smoke \
  --epochs 1 --max-steps 3 --grad-accum 1 --max-len 4096 --dtype bfloat16 --chunk-rows 1 \
  2>&1 | tee "$LOG/e2a.log"

step E1-7B-ZEROSHOT
openjev eval -m "$MODEL7" --dtype bfloat16 \
  --data /root/jev/dev-v3.jsonl 2>&1 | tee "$LOG/e1-7b.json"

step E1B-1.5B-ZEROSHOT
openjev eval -m "$MODEL15" --dtype bfloat16 \
  --data /root/jev/dev-v3.jsonl 2>&1 | tee "$LOG/e1b-1.5b.json"

step E2-LORA-1.5B   # 子集 1200；naive chunk fn rows=1（实测峰值 16.3GB、5.1s/step；
#   1.7h 基准 ×1.5 争用余量 → 03:15-04:15 完成，硬停 04:27）；max-len 4096；epochs 1
python /root/jev/train_calibrated_chunked.py --model "$MODEL15" \
  --data /root/jev/train-sub1200.jsonl --eval-data /root/jev/dev-v3.jsonl \
  --output /root/jev/ckpt/lora-1.5b-v3 --epochs 1 --max-len 4096 --brier-weight 0.5 \
  --grad-accum 1 --chunk-rows 1 \
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
