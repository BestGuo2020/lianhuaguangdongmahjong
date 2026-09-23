# Jev AutoDL GPU 轮次记录（2026-09-23，进行中→结案）

前置：`jev-cpu-pilot-2026-09-23.md`（v1 拒绝）后用户拍板 AutoDL 自炼路线。实例：AutoDL 西北B vGPU-32GB（RTX 4080 SUPER 切片，¥1.58/时），torch 2.12.1+cu130，conda py3.12。预算纪律：实验段 ≤¥60 或 ≤8h（自 20:27 起算，硬停 04:27）。

## 一、零shot 基线（dev-v3 全量 858 条，GPU 实测）

| 模型 | accuracy | NLL | ECE |
|---|---:|---:|---:|
| Qwen2.5-7B-Instruct zero-shot | **19.3%** | 4.587 | 0.570 |
| Qwen2.5-1.5B-Instruct zero-shot | **23.7%** | 2.507 | 0.324 |
| （背景参考）1.5B + 温度校正（250 子采样口径） | 26.4% | 1.866 | 0.140 |

**7B 弱于 1.5B**——更大基座在本任务（中文麻将紧凑特征 + 闭集决策）上无优势且更过度自信。
副作用：E3（7B LoRA）门槛条件「E1 acc≥35%」直接不成立（19.3%），**该分支自动熄灭，预算未花**。

## 二、基础设施排障日志（同根因链，全部已修并提交）

1. **HF 直连 OSError**（数据中心 IP）→ 换 ModelScope 镜像下载至数据盘（`238e116`）。
2. **conda 不在非交互 PATH / 镜像无 tmux** → 脚本 source conda + nohup（`4c8f74e`）。
3. **上游 train_calibrated 内存炸弹**：全候选单批 × 全词表 logits.float()+log_softmax ≈ 39GB → 本地段错误与远端 OOM 同根因；vendored `train_calibrated_chunked.py`：逐候选行 forward + 目标位置 logsumexp（`2e1dc60`）。
4. **chunk 循环索引 bug**：把整行当候选段 → positions 越界 device-side assert（`2187813`）。
5. **logits 驻留 OOM**：advanced indexing / contiguous / clone 的 backward 均保留全宽 logits 存储引用（实测 ~4.9GB/chunk 驻留）→ **activation checkpoint 包 chunk forward**（no-grad 执行、backward 重算）为唯一结构性保证；峰值 16.3GB/32GB（`5d03fb6`）。
6. **步速预算**：chunk-rows=1 实测 5.1s/step → 7413 步 10.5h 超预算 → chunk-rows=4（forward 次数 ÷4，峰值瞬态 ~20GB 仍安全），epochs 2→1（偏离已记录）（`1f8475e`）。
7. **运维陷阱**：`pkill -f <pattern>` 的 pattern 出现在 ssh 会话自身 cmdline → 自杀（造成一次双编排并存）；括号正则 `[r]un-...` 规避。pwsh 管道按 CRLF 重编码远端脚本 → 一律走 scp 文件执行。vGPU 宿主机 load 17–19 时 ssh 会话偶发挂死 → 短超时重试。

## 三、E2 蒸馏与门槛判定

<!-- FILL:E2_RESULTS -->

## 四、E4 pilot 与结案

<!-- FILL:E4_RESULTS -->

## 五、边界与下一步

<!-- FILL:NEXT -->
