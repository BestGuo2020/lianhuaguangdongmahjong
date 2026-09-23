"""细粒度诊断：KV-cache 步评分 vs 单行参照；区分「共享 cache 被污染」与「算法错」。"""
import json
import sys

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

sys.path.insert(0, r'D:\vueprojects\OpenJev\scripts')
from openjev.backends.hf import HFPromptRenderer  # noqa: E402
from openjev.prompting import PromptConfig, compile_request  # noqa: E402
from openjev.schema import SystemOneRequest  # noqa: E402

MODEL = r'Qwen/Qwen2.5-1.5B-Instruct'
row = None
with open(r'D:\vueprojects\lianhua_guangma\work\jev-calibration\train-v3.jsonl', encoding='utf8') as fh:
    for line in fh:
        r = json.loads(line)
        if len(r['questions']['action']['criteria']) >= 12:
            row = r
            break
req = SystemOneRequest.model_validate({'state': row['state'], 'questions': row['questions']})
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.float32)
model.eval()
renderer = HFPromptRenderer(tok)
pc = PromptConfig()
dec = next(d for d in compile_request(req.state, req.questions, pc) if d.name == 'action')
prefix = renderer.render_prompt(dec.prompt)
cands = renderer.candidate_ids(dec.candidates)
plen = len(prefix)
p = torch.tensor([prefix])


def lp1(row_logits, target):
    rowf = row_logits.float()
    return (rowf[target] - torch.logsumexp(rowf, dim=-1))


def ref_lp(c):
    with torch.inference_mode():
        out = model(input_ids=torch.tensor([prefix + c]))
        pos0 = plen - 1
        lg = out.logits[0, pos0:pos0 + len(c), :].float()
        idx = torch.arange(len(c))
        return (lg[idx, torch.tensor(c)] - torch.logsumexp(lg, dim=-1)).sum().item()


def kv_lp(c, cache_src, first_src):
    with torch.inference_mode():
        lps = [lp1(first_src, torch.tensor([c[0]]))]
        cur = cache_src
        nxt = torch.tensor([[c[0]]])
        for t in range(1, len(c)):
            am = torch.ones((1, plen + t), dtype=torch.long)
            o = model(input_ids=nxt, attention_mask=am, past_key_values=cur, use_cache=True)
            cur = o.past_key_values
            lps.append(lp1(o.logits[0, -1, :], torch.tensor([c[t]])))
            nxt = torch.tensor([[c[t]]])
        return sum(x.item() for x in lps)


with torch.inference_mode():
    o0 = model(input_ids=p, use_cache=True)
    cache0 = o0.past_key_values
    first0 = o0.logits[0, -1, :]
    r0, r5 = ref_lp(cands[0]), ref_lp(cands[5])
    k0 = kv_lp(cands[0], cache0, first0)
    k5_shared = kv_lp(cands[5], cache0, first0)
    o0b = model(input_ids=p, use_cache=True)
    k5_fresh = kv_lp(cands[5], o0b.past_key_values, o0b.logits[0, -1, :])
    # 单 token 步对齐检查：candidate0 的第二 token logprob（共享 vs 新鲜 vs 参照内部）
    print(f'ref0={r0:.4f} kv0_shared={k0:.4f}')
    print(f'ref5={r5:.4f} kv5_shared={k5_shared:.4f} kv5_fresh={k5_fresh:.4f}')
    print('cache type:', type(cache0))
