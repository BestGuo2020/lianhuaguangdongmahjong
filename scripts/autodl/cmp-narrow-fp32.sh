#!/usr/bin/env bash
# fp32 对照：上游原版 vs 第四版（窄样本，数学等价性定谳，差应 <1e-3）
set -uo pipefail
source /root/miniconda3/etc/profile.d/conda.sh && conda activate base
echo ---UPSTREAM-FP32---
cd /root/OpenJev
python scripts/train_calibrated.py --model /root/autodl-tmp/models/Qwen2.5-1.5B-Instruct \
  --data /root/jev/narrow1.jsonl --output /root/jev/ckpt/ref-narrow-fp32 \
  --epochs 1 --max-steps 1 --grad-accum 1 --max-len 4096 --dtype float32 2>&1 | grep -E 'loss|decisions'
echo ---V4-FP32---
cd /root/jev
python train_calibrated_chunked.py --model /root/autodl-tmp/models/Qwen2.5-1.5B-Instruct \
  --data /root/jev/narrow1.jsonl --output /root/jev/ckpt/v4-narrow-fp32 \
  --epochs 1 --max-steps 1 --grad-accum 1 --max-len 4096 --dtype float32 --chunk-rows 8 2>&1 | grep -E 'loss|decisions'
