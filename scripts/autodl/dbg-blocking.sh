#!/usr/bin/env bash
# 调试：CUDA_LAUNCH_BLOCKING=1 单步复现 device-side assert，拿真实栈
set -uo pipefail
source /root/miniconda3/etc/profile.d/conda.sh && conda activate base
cd /root/jev
CUDA_LAUNCH_BLOCKING=1 python train_calibrated_chunked.py \
  --model /root/autodl-tmp/models/Qwen2.5-1.5B-Instruct \
  --data /root/jev/train-smoke.jsonl --output /root/jev/ckpt/smoke2 \
  --epochs 1 --max-steps 1 --grad-accum 1 --max-len 4096 --dtype bfloat16 \
  > /root/jev/blocking.log 2>&1
echo REMOTE_EXIT=$?
tail -30 /root/jev/blocking.log
