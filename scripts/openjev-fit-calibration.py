# 单遍温度校正 + 评估（OpenJev，CPU 预算：每样本只过一次模型）。
#
# 为什么不用 CLI：`openjev calibrate` 与 `openjev eval` 各自对数据集整体过一遍模型
# （校正前 eval + 校正 + 校正后 eval = 3 遍评分，CPU 上每遍数小时）。温度缩放不改变
# argmax（只改分布锐度），因此本脚本一次评分缓存 logprobs 后：
#   - 在 train 上黄金分割拟合 choice 温度 T*（纯数学，不再过模型）；
#   - dev 在 T=1 与 T* 两组下用同一份缓存 logprobs 计算 accuracy / NLL / ECE。
# 评分结果逐行写入 --cache-dir（含 rowIndex，断点续跑：同参数重跑跳过已评分行）。
#
# 运行（OpenJev 的 venv，本仓库根目录）：
#   D:\vueprojects\OpenJev\.venv\Scripts\python.exe scripts/openjev-fit-calibration.py `
#     --train work/jev-calibration/train.jsonl --dev work/jev-calibration/dev.jsonl `
#     --cache-dir work/jev-calibration/cache-v2 `
#     --output work/jev-calibration/calibration-v2.json `
#     --metrics work/jev-calibration/metrics-v2.json
import argparse
import json
import math
import random
import time
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description='One-pass temperature calibration + eval for OpenJev')
    parser.add_argument('--model', default='Qwen/Qwen2.5-1.5B-Instruct')
    parser.add_argument('--adapter', default=None,
                        help='LoRA adapter 目录（与 openjev serve --adapter 同口径）；蒸馏模型必须带，否则校正的是基座')
    parser.add_argument('--dtype', default='bfloat16')
    parser.add_argument('--device', default='cpu')
    parser.add_argument('--train', required=True)
    parser.add_argument('--dev', required=True)
    parser.add_argument('--train-limit', type=int, default=400, help='0=全量')
    parser.add_argument('--dev-limit', type=int, default=250, help='0=全量')
    parser.add_argument('--sample-seed', type=int, default=7, help='子采样洗牌种子（续跑必须一致）')
    parser.add_argument('--cache-dir', required=True)
    parser.add_argument('--output', required=True, help='calibration JSON（openjev serve --calibration 用）')
    parser.add_argument('--metrics', required=True)
    parser.add_argument('--question', default='action')
    args = parser.parse_args()

    from openjev import SystemOneEngine, load_backend
    from openjev.calibration import Calibration, expected_calibration_error, fit_temperature, softmax
    from openjev.schema import SystemOneRequest

    cache_dir = Path(args.cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)

    def load_rows(path: str, limit: int, seed: int) -> list[dict]:
        rows = [json.loads(line) for line in Path(path).read_text(encoding='utf8').splitlines() if line.strip()]
        random.Random(seed).shuffle(rows)
        return rows[:limit] if limit > 0 else rows

    engine_holder: dict = {}

    def get_engine() -> SystemOneEngine:
        if 'engine' not in engine_holder:
            started = time.time()
            adapter_note = f' + adapter {args.adapter}' if args.adapter else ''
            print(f'loading backend {args.model}{adapter_note} ({args.dtype}/{args.device}) ...', flush=True)
            engine_holder['engine'] = SystemOneEngine(backend=load_backend(
                args.model, device=args.device, dtype=args.dtype,
                **({'adapter': args.adapter} if args.adapter else {})))
            print(f'backend ready in {time.time() - started:.1f}s', flush=True)
        return engine_holder['engine']

    def score_split(name: str, rows: list[dict]) -> list[dict]:
        cache_path = cache_dir / f'scored-{name}.jsonl'
        cached: dict[int, dict] = {}
        if cache_path.exists():
            for line in cache_path.read_text(encoding='utf8').splitlines():
                if not line.strip():
                    continue
                entry = json.loads(line)
                cached[int(entry['rowIndex'])] = entry
        todo = [index for index in range(len(rows)) if index not in cached]
        if not todo:
            print(f'[{name}] {len(cached)} rows fully cached, skip scoring', flush=True)
        else:
            engine = get_engine()
            started = time.time()
            skipped = 0
            scored = 0
            with open(cache_path, 'a', encoding='utf8') as sink:
                for position, index in enumerate(todo):
                    row = rows[index]
                    request = SystemOneRequest.model_validate({'state': row['state'], 'questions': row['questions']})
                    raws, _usage = engine.evaluate_raw(request)
                    raw = next((r for r in raws if r.decision.name == args.question and r.decision.kind == 'choice'), None)
                    gold = row.get('gold', {}).get(args.question)
                    outcomes = list(raw.decision.outcomes) if raw is not None else []
                    if raw is None or gold is None or str(gold) not in outcomes:
                        skipped += 1
                        continue
                    entry = {
                        'rowIndex': index,
                        'logprobs': list(raw.logprobs),
                        'outcomes': outcomes,
                        'goldIdx': outcomes.index(str(gold)),
                    }
                    sink.write(json.dumps(entry, ensure_ascii=False) + '\n')
                    sink.flush()
                    cached[index] = entry
                    scored += 1
                    if scored % 10 == 0:
                        elapsed = time.time() - started
                        eta = elapsed / scored * (len(todo) - position - 1)
                        print(f'[{name}] {position + 1}/{len(todo)} new, {elapsed / scored:.1f}s/row, '
                              f'ETA {eta / 60:.0f} min, skipped {skipped}', flush=True)
        return [cached[index] for index in sorted(cached)]

    train_rows = load_rows(args.train, args.train_limit, args.sample_seed)
    dev_rows = load_rows(args.dev, args.dev_limit, args.sample_seed + 1)
    train = score_split('train', train_rows)
    dev = score_split('dev', dev_rows)
    if not train or not dev:
        print('train/dev 评分样本为空，无法拟合', flush=True)
        return 1

    temperature = fit_temperature([e['logprobs'] for e in train], [e['goldIdx'] for e in train])

    def metrics(entries: list[dict], temperature_value: float) -> dict:
        n = len(entries)
        correct = 0
        nll = 0.0
        confs: list[float] = []
        oks: list[bool] = []
        for entry in entries:
            probs = softmax(entry['logprobs'], temperature_value)
            pred = max(range(len(probs)), key=probs.__getitem__)
            ok = pred == entry['goldIdx']
            correct += int(ok)
            nll -= math.log(max(probs[entry['goldIdx']], 1e-12))
            confs.append(probs[pred])
            oks.append(ok)
        return {'n': n, 'accuracy': correct / n, 'nll': nll / n, 'ece': expected_calibration_error(confs, oks)}

    report = {
        'model': args.model,
        'adapter': args.adapter,
        'dtype': args.dtype,
        'device': args.device,
        'sampleSeed': args.sample_seed,
        'question': args.question,
        'temperatureChoice': temperature,
        'train': {'scored': len(train), 'metricsAtTStar': metrics(train, temperature)},
        'dev': {'scored': len(dev), 't1': metrics(dev, 1.0), 'tStar': metrics(dev, temperature)},
        'note': '温度缩放不改变 argmax：dev accuracy 校正前后相同；NLL/ECE 基于同一份缓存 logprobs；'
                'train/dev 均取自 EV 策略轨迹（teacher-on-policy）',
        'finishedAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
    }
    calibration = Calibration()
    calibration.temperatures['choice'] = float(temperature)
    calibration.save(args.output)
    Path(args.metrics).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf8')
    print(json.dumps(report, indent=2, ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
