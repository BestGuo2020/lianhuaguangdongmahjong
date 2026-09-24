#!/usr/bin/env bash
# 蒸馏迭代第二轮远端训练（nohup 后台）：
#   nohup bash iter2-train.sh > iter2-nohup.out 2>&1 &
# 数据 = head-5000(teacher) + dagger-v1（学生轨迹+教师标签）；rows=2 + 1 epoch + bf16 + brier 0.5。
# 门槛（预注册）由代理读 logs-iter2/train.log 的 eval 行判定：acc>=0.75 且 NLL<=1.2 才进 pilot。
set -euo pipefail
export HF_HOME=/root/autodl-tmp/hf
if ! command -v python >/dev/null 2>&1; then
  source /root/miniconda3/etc/profile.d/conda.sh
  conda activate base
fi
MODEL15=/root/autodl-tmp/models/Qwen2.5-1.5B-Instruct
cd /root/OpenJev
LOG=/root/jev/logs-iter2
mkdir -p "$LOG" /root/jev/ckpt

head -n 5000 /root/jev/train-v3-all.jsonl > /root/jev/train2-teacher.jsonl
cat /root/jev/train2-teacher.jsonl /root/jev/dagger-v1.jsonl > /root/jev/train2-all.jsonl
wc -l /root/jev/train2-all.jsonl | tee -a "$LOG/run.log"

python /root/jev/train_calibrated_chunked.py --model "$MODEL15" \
  --data /root/jev/train2-all.jsonl --eval-data /root/jev/dev-v3.jsonl \
  --output /root/jev/ckpt/lora-1.5b-v3-iter2 --epochs 1 --max-len 4096 --brier-weight 0.5 \
  --grad-accum 1 --chunk-rows 2 --dtype bfloat16 2>&1 | tee "$LOG/train.log"
echo "[$(date '+%F %T')] ITER2_TRAIN_DONE" | tee -a "$LOG/run.log"
