# OpenJev 训练数据 token 长度探针：量出 {state,questions} 经官方渲染管线后的真实长度分布，
# 防止 train_calibrated.py 的 --max-len 静默跳过样本（v3 state 含 ~1k token 规则文本，
# 默认 2048 会跳过大部分样本——本工具在租 GPU 之前把这件事量清楚）。
#
# 运行（OpenJev 的 venv，本仓库根目录）：
#   D:\vueprojects\OpenJev\.venv\Scripts\python.exe scripts/openjev-token-probe.py \
#     --data work/jev-calibration/train-v3.jsonl [--data work/jev-calibration/train-v3-ext.jsonl ...] \
#     --tokenizer Qwen/Qwen2.5-1.5B-Instruct --sample 150 [--seed 7]
#
# 输出：每个 (data, question) 的 prefix/total token 分布（p50/p95/max）与超过 2048/3072/4096/8192 的样本占比。
# 口径与 train_calibrated.py 的 load_examples 完全一致（compile_request + HFPromptRenderer）。
import argparse
import json
import random
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description='Token length probe for OpenJev training data')
    parser.add_argument('--data', action='append', required=True, help='JSONL 路径（可多次）')
    parser.add_argument('--tokenizer', default='Qwen/Qwen2.5-1.5B-Instruct')
    parser.add_argument('--sample', type=int, default=150, help='每个文件抽样行数（0=全量）')
    parser.add_argument('--seed', type=int, default=7)
    parser.add_argument('--question', default='action')
    args = parser.parse_args()

    from openjev.backends.hf import HFPromptRenderer
    from openjev.prompting import PromptConfig, compile_request
    from openjev.schema import SystemOneRequest
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(args.tokenizer)
    renderer = HFPromptRenderer(tokenizer)
    prompt_config = PromptConfig()
    thresholds = [2048, 3072, 4096, 8192]

    report = {}
    for path in args.data:
        rows = [json.loads(line) for line in Path(path).read_text(encoding='utf8').splitlines() if line.strip()]
        if args.sample and len(rows) > args.sample:
            random.Random(args.seed).shuffle(rows)
            rows = rows[:args.sample]
        totals = []
        gold_missing = 0
        for row in rows:
            request = SystemOneRequest.model_validate({'state': row['state'], 'questions': row['questions']})
            for decision in compile_request(request.state, request.questions, prompt_config):
                if decision.name != args.question:
                    continue
                if decision.name not in row.get('gold', {}):
                    gold_missing += 1
                    continue
                prefix = renderer.render_prompt(decision.prompt)
                candidates = renderer.candidate_ids(decision.candidates)
                totals.append(len(prefix) + max(len(c) for c in candidates))
        totals.sort()
        n = len(totals)
        if not n:
            report[Path(path).name] = {'error': 'no samples'}
            continue
        percentile = lambda q: totals[min(n - 1, int(q * n))]  # noqa: E731
        report[Path(path).name] = {
            'n': n,
            'goldMissing': gold_missing,
            'p50': percentile(0.5), 'p95': percentile(0.95), 'max': totals[-1],
            'overThresholds': {str(t): round(sum(1 for x in totals if x > t) / n, 4) for t in thresholds},
        }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
