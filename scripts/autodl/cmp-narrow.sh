#!/usr/bin/env bash
# 第四版 candidate_logprobs 与上游原版（单批全词表）在 GPU bf16 窄样本上的 loss 对照
set -uo pipefail
source /root/miniconda3/etc/profile.d/conda.sh && conda activate base
python - <<'PY'
import json
rows = [json.loads(l) for l in open('/root/jev/train-v3-all.jsonl') if l.strip()]
narrow = [r for r in rows if len(r['questions']['action']['criteria']) <= 3][:1]
open('/root/jev/narrow1.jsonl', 'w').write(json.dumps(narrow[0]) + '\n')
print('narrow cands:', len(narrow[0]['questions']['action']['criteria']))
PY
echo ---UPSTREAM---
cd /root/OpenJev
python scripts/train_calibrated.py --model /root/autodl-tmp/models/Qwen2.5-1.5B-Instruct \
  --data /root/jev/narrow1.jsonl --output /root/jev/ckpt/ref-narrow \
  --epochs 1 --max-steps 1 --grad-accum 1 --max-len 4096 --dtype bfloat16 2>&1 | grep -E 'loss|decisions'
echo ---V4---
cd /root/jev
python train_calibrated_chunked.py --model /root/autodl-tmp/models/Qwen2.5-1.5B-Instruct \
  --data /root/jev/narrow1.jsonl --output /root/jev/ckpt/v4-narrow \
  --epochs 1 --max-steps 1 --grad-accum 1 --max-len 4096 --dtype bfloat16 --chunk-rows 8 2>&1 | grep -E 'loss|decisions'
