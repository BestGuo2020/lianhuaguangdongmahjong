#!/usr/bin/env bash
# iter2 独立复核：openjev eval（对拍门槛 acc/NLL）+ 温度校准（T*、dev t1/tStar 指标）
# 门槛已判定（脚本内 eval acc=0.734<0.75）；此为独立确认 + 补全画像，不改门槛。
set -euo pipefail
export HF_HOME=/root/autodl-tmp/hf
if ! command -v python >/dev/null 2>&1; then
  source /root/miniconda3/etc/profile.d/conda.sh
  conda activate base
fi
MODEL15=/root/autodl-tmp/models/Qwen2.5-1.5B-Instruct
LOG=/root/jev/logs-iter2
mkdir -p "$LOG"

echo "=== ITER2 INDEPENDENT EVAL (dev-v3 full 858, T=1) ==="
openjev eval -m "$MODEL15" --adapter /root/jev/ckpt/lora-1.5b-v3-iter2 \
  --dtype bfloat16 --data /root/jev/dev-v3.jsonl 2>&1 | tee "$LOG/iter2-eval-independent.txt"

echo "=== ITER2 CALIBRATION (fit T*, dev t1/tStar metrics) ==="
cd /root/OpenJev
python /root/jev/openjev-fit-calibration.py --device cuda \
  --model "$MODEL15" --adapter /root/jev/ckpt/lora-1.5b-v3-iter2 \
  --train /root/jev/train2-all.jsonl --dev /root/jev/dev-v3.jsonl \
  --train-limit 800 --dev-limit 0 --sample-seed 7 \
  --cache-dir /root/jev/cache-iter2 --output /root/jev/calibration-iter2.json \
  --metrics /root/jev/metrics-iter2.json 2>&1 | tee "$LOG/iter2-calib.txt"

echo "=== METRICS JSON ==="
cat /root/jev/metrics-iter2.json 2>/dev/null || true
echo ""
echo "=== VERIFY_CALIB_DONE ==="
