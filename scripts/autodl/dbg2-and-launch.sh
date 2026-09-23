#!/usr/bin/env bash
# 修复验证 + 点火：dbg 单步通过（saved LoRA adapter）才启动完整编排
set -uo pipefail
bash /root/jev/dbg-blocking.sh > /root/jev/dbg2.out 2>&1
tail -3 /root/jev/dbg2.out
if grep -q "saved LoRA adapter" /root/jev/blocking.log; then
  rm -rf /root/jev/logs
  cd /root/autodl-tmp/jev && setsid nohup bash run-experiments.sh > exp-nohup.out 2>&1 < /dev/null &
  echo EXP3_STARTED
else
  echo DBG_FAILED
  tail -15 /root/jev/blocking.log
fi
