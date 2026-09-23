#!/usr/bin/env bash
# 调试/门控：宽样本（>=12 候选）单步验证（数学+显存），CUDA_LAUNCH_BLOCKING 拿精确栈
set -uo pipefail
source /root/miniconda3/etc/profile.d/conda.sh && conda activate base
cd /root/jev
python - <<'PY'
import json
out = []
with open('/root/jev/train-v3-all.jsonl', encoding='utf8') as src:
    for line in src:
        row = json.loads(line)
        if len(row['questions']['action']['criteria']) >= 12:
            out.append(line)
        if len(out) >= 3:
            break
with open('/root/jev/train-smoke-wide.jsonl', 'w', encoding='utf8') as dst:
    dst.writelines(out)
print('wide samples:', len(out))
PY
CUDA_LAUNCH_BLOCKING=1 python train_calibrated_chunked.py \
  --model /root/autodl-tmp/models/Qwen2.5-1.5B-Instruct \
  --data /root/jev/train-smoke-wide.jsonl --output /root/jev/ckpt/smoke3 \
  --epochs 1 --max-steps 1 --grad-accum 1 --max-len 4096 --dtype bfloat16 --chunk-rows 1 \
  > /root/jev/blocking.log 2>&1
echo REMOTE_EXIT=$?
tail -6 /root/jev/blocking.log
