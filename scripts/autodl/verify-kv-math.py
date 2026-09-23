"""本地交叉验证：KV-cache 单 token 步评分 vs 单行全宽前向参照（fp32、无 cache、无 grad）。
同一样本、同一模型（1.5B CPU fp32），比较每候选 logprob 向量与 gold 损失。
用法：python scripts/autodl/verify-kv-math.py
"""
import json
import sys

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

sys.path.insert(0, r'D:\vueprojects\OpenJev\scripts')
from openjev.backends.hf import HFPromptRenderer  # noqa: E402
from openjev.prompting import PromptConfig, compile_request  # noqa: E402
from openjev.schema import SystemOneRequest  # noqa: E402

MODEL = r'D:\vueprojects\lianhua_guangma\work\autodl-upload\..\..\vueprojects'  # placeholder, replaced below
MODEL = r'Qwen/Qwen2.5-1.5B-Instruct'

# 取第一个 >=12 候选的样本
row = None
with open(r'D:\vueprojects\lianhua_guangma\work\jev-calibration\train-v3.jsonl', encoding='utf8') as fh:
    for line in fh:
        r = json.loads(line)
        if len(r['questions']['action']['criteria']) >= 12:
            row = r
            break
assert row is not None

tok = AutoTokenizer.from_pretrained(MODEL)
if tok.pad_token_id is None:
    tok.pad_token = tok.eos_token
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.float32)
model.eval()
renderer = HFPromptRenderer(tok)
pc = PromptConfig()
dec = next(d for d in compile_request(
    SystemOneRequest.model_validate({'state': row['state'], 'questions': row['questions']}).state,
    SystemOneRequest.model_validate({'state': row['state'], 'questions': row['questions']}).questions,
    pc) if d.name == 'action')
prefix = renderer.render_prompt(dec.prompt)
cands = renderer.candidate_ids(dec.candidates)
gold = row['gold']['action']
gold_idx = dec.outcomes.index(str(gold))
print('candidates:', len(cands), 'gold idx:', gold_idx)


def logsum_row(logits_row, targets):
    rowf = logits_row.float()
    if rowf.dim() == 1:
        return rowf[targets] - torch.logsumexp(rowf, dim=-1)
    idx = torch.arange(rowf.size(0))
    return rowf[idx, targets] - torch.logsumexp(rowf, dim=-1)


with torch.inference_mode():
    # 参照：每候选单行全宽前向
    ref = []
    for c in cands:
        ids = torch.tensor([prefix + c])
        out = model(input_ids=ids)
        pos0 = len(prefix) - 1
        lg = out.logits[0, pos0:pos0 + len(c), :]
        ref.append(logsum_row(lg, torch.tensor(c)).sum().item())
    # KV-cache 单 token 步
    kv = []
    with torch.enable_grad():
        pass
    p = torch.tensor([prefix])
    out0 = model(input_ids=p, use_cache=True)
    cache = out0.past_key_values
    first = out0.logits[0, -1, :]
    plen = p.size(1)
    for c in cands:
        lps = [logsum_row(first, torch.tensor([c[0]]))]
        cur_cache = cache
        nxt = torch.tensor([[c[0]]])
        for t in range(1, len(c)):
            am = torch.ones((1, plen + t), dtype=torch.long)
            o = model(input_ids=nxt, attention_mask=am, past_key_values=cur_cache, use_cache=True)
            cur_cache = o.past_key_values
            lps.append(logsum_row(o.logits[0, -1, :], torch.tensor([c[t]])))
            nxt = torch.tensor([[c[t]]])
        kv.append(torch.stack(lps).sum().item())

ref_t = torch.tensor(ref)
kv_t = torch.tensor(kv)
diff = (ref_t - kv_t).abs()
print('max abs diff per-candidate logprob:', diff.max().item())
print('ref loss(gold):', (ref_t.log_softmax(0)[gold_idx] * -1).item())
print('kv  loss(gold):', (kv_t.log_softmax(0)[gold_idx] * -1).item())
print('ref argmax:', ref_t.argmax().item(), 'kv argmax:', kv_t.argmax().item())
