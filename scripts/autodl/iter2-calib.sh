#!/usr/bin/env bash
# iter2 温度校准（晨间、门槛通过后执行）：给 iter2 adapter 拟合 T*
#   nohup bash iter2-calib.sh > calib-nohup.out 2>&1 &
set -euo pipefail
export HF_HOME=/root/autodl-tmp/hf
if ! command -v python >/dev/null 2>&1; then
  source /root/miniconda3/etc/profile.d/conda.sh
  conda activate base
fi
MODEL15=/root/autodl-tmp/models/Qwen2.5-1.5B-Instruct
cd /root/OpenJev
LOG=/root/jev/logs-iter2
mkdir -p "$LOG"
python /root/jev/openjev-fit-calibration.py --device cuda \
  --model "$MODEL15" --adapter /root/jev/ckpt/lora-1.5b-v3-iter2 \
  --train /root/jev/train2-all.jsonl --dev /root/jev/dev-v3.jsonl \
  --train-limit 800 --dev-limit 0 --sample-seed 7 \
  --cache-dir /root/jev/cache-iter2 --output /root/jev/calibration-iter2.json \
  --metrics /root/jev/metrics-iter2.json 2>&1 | tee "$LOG/calib.log"
echo "[$(date '+%F %T')] ITER2_CALIB_DONE" | tee -a "$LOG/run.log"
