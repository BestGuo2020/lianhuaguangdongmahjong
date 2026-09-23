#!/usr/bin/env bash
# AutoDL 实例一键装环境（OpenJev + 训练/服务依赖 + 基座预下载）。
# 租机时选 PyTorch 2.x + CUDA 12 + Python≥3.10 的基础镜像；本脚本用 scp 传到实例后执行：
#   bash setup-openjev.sh
# 幂等：重复执行安全（已 clone/已下载会跳过或秒过缓存）。
set -euo pipefail

# AutoDL「学术资源加速」（HF/GitHub 提速；镜像没有该脚本就跳过）
[ -f /etc/network_turbo ] && source /etc/network_turbo || true

cd /root
if [ ! -d OpenJev ]; then
  git clone --depth 1 https://github.com/GitHub30/OpenJev.git
fi
cd OpenJev
# 镜像自带 CUDA 版 torch（>=2.1 即满足依赖，pip 不会重装巨型轮子）；补 server/train 附加依赖
pip install -e ".[hf,server,train]"

python - <<'PY'
import torch, transformers, peft
print('torch', torch.__version__, '| cuda available:', torch.cuda.is_available(),
      '|', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NO GPU!')
print('transformers', transformers.__version__, '| peft', peft.__version__)
assert torch.cuda.is_available(), '实例没有可用 GPU——检查租机配置'
PY

# 预下载基座（HF 缓存进 ~/.cache，之后训练/评估/serve 免等待）
python - <<'PY'
from transformers import AutoModelForCausalLM, AutoTokenizer
for m in ['Qwen/Qwen2.5-1.5B-Instruct', 'Qwen/Qwen2.5-7B-Instruct']:
    print('downloading', m, flush=True)
    AutoTokenizer.from_pretrained(m)
    AutoModelForCausalLM.from_pretrained(m)
PY

echo SETUP_OK
