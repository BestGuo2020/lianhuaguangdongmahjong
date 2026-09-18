# 单机 LLM 透传网关（无浏览器 CORS 的供应商）

> 结论：千问 Token Plan / Coding Plan 这类端点**不能从网页直连**，也没有任何前端写法
> 能绕过去；正确做法是经自家后端的白名单透传通道调用。本文记录实测证据、
> 实现位置与部署注意。

## 1. 起因

玩家在线上（`https://lianhuaguangdongmahjong.guoguo-labs.online`）配置千问 Token Plan
后，浏览器控制台报：

```
Access to fetch at 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions'
from origin 'https://lianhuaguangdongmahjong.guoguo-labs.online' has been blocked by CORS policy:
Response to preflight request doesn't pass access control check:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

## 2. 实测证据（2026-09-18，`curl -X OPTIONS` 带站点 Origin 打预检）

| 端点 | 预检结果 |
|---|---|
| `token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions` | `401`，**无任何 `Access-Control-*` 头** |
| `token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages` | `401`，无 CORS 头 |
| `coding.dashscope.aliyuncs.com/v1/chat/completions`（Coding Plan） | `401`，无 CORS 头 |
| `dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`（按量付费） | `200` + `access-control-allow-origin: *` ✅ |
| `api.deepseek.com/v1/chat/completions` | `200` + 回显请求 Origin ✅ |

两点结论：

1. 单机模式（`src/game/llm/client.ts`）是**浏览器直连供应商**，请求带 `Authorization`
   与 `application/json`，必然触发预检。Token Plan 域名对预检直接 401 → 浏览器拦掉。
   这是**服务端行为**，前端无法修（也不该用 fetch/headers 技巧去绕）。
2. 官方明确 Token Plan（`sk-sp-`）、Coding Plan（`sk-ws-`）、按量付费（`sk-`）三套
   凭证与 Base URL **完全隔离、不可混用**（[快速开始](https://www.alibabacloud.com/help/zh/model-studio/token-plan-team-quickstart)），
   所以「换成 `dashscope.aliyuncs.com` 地址」会 401/403 或误走按量计费扣费，不是解法。
   Token Plan 面向 Claude Code / Cursor / Codex 这类能填自定义 Base URL 的 CLI 工具，
   设计上就不给浏览器用。

## 3. 方案：自家后端白名单透传

```
浏览器（master: guoguo-labs.online / vibehub: *.gamesvibe.app）
   │  POST https://www.bestguo.top:58000/api/llm/relay/token-plan/chat/completions
   │  Authorization: Bearer sk-sp-<玩家自己的套餐 Key>
   ▼
自家网关（FastAPI，回 CORS 头；上游白名单在服务端）
   │  原样转发请求体 + Authorization
   ▼
token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions
   │  SSE
   ▼  原样流式回传（X-Accel-Buffering: no）
```

为什么是后端而不是「站点边缘函数」：master 跑在自家 EdgeOne Makers 上、可以加边缘函数
做同源反代；但 **vibehub 跑在平台域名（`gamesvibe.app` / `apps.gamesvibe.app`）下，
既没有自家 origin、也改不了平台响应头**，边缘函数方案在那边物理上不成立。
后端网关两边的 CORS 白名单都已经放行（`app/main.py`），**一份部署同时覆盖两个分支**，
所以只做这一套。若以后想给 master 再省一跳，可另加 EdgeOne 边缘函数，但不影响本通道。

## 4. 实现位置

| 位置 | 作用 |
|---|---|
| `backend/app/api/llm_relay.py` | 透传端点：上游白名单、限流、体积上限、SSE 流式回传 |
| `backend/app/main.py` | 注册路由；启动日志打印上游 id；退出时关闭共享 httpx client |
| `backend/tests/test_llm_relay.py` | 白名单/穿越/Key 校验/透传保真/错误透出/体积/限流/CORS 预检 |
| `src/game/llm/config.ts` | `LLM_RELAY_GATEWAY`、`llmRelayBaseUrl()`、预置「千问 Token Plan（经网关）」 |
| `src/game/llm/persona.ts` | token-plan 家族（原地址或透传地址）归到千问头像/昵称 |
| `src/game/llm/relayGateway.test.ts` | 预置契约、地址可被客户端校验、千问识别与思考关闭不回归 |
| `backend/.env.example` / `backend/DEPLOY.md` | `LLM_RELAY_UPSTREAMS`、`LLM_RELAY_RATE_LIMIT_PER_MINUTE` 与反代要求 |

## 5. 怎么用

玩家侧：AI 设置 → 新增预置 → 选「千问 Token Plan（经网关）」→ 填入自己的
`sk-sp-` 开头的 Token Plan Key（模型名按套餐支持列表核对，缺省 `qwen3.6-plus`）。

开发者侧：需要接入别的「无 CORS」端点（例如 Coding Plan）时，只加服务端白名单即可：

```bash
LLM_RELAY_UPSTREAMS=coding=https://coding.dashscope.aliyuncs.com/v1
```

客户端只能传 id（`/api/llm/relay/<id>/chat/completions`），**不能传 URL**。
前端再按需加一条 `llmRelayBaseUrl('<id>')` 的预置。

## 6. 安全边界（改动时务必保持）

- **上游由服务端白名单决定**：客户端只能选 id，避免端点变成人人可用的 SSRF 跳板。
  非 https、带 userinfo、id 非法的配置项一律忽略。
- **Key 不落服务端**：玩家自己的 Key 由浏览器携带并原样透传给上游；服务端不保存、
  不写日志、不回显（现有访问日志只记 method/path/状态/耗时/IP/query）。
  请求只转发 `content-type` / `authorization` / `accept`，不转发 `Origin`/`Referer`/`Cookie`。
- **体积与频率**：请求体上限 64KB（无 content-length 的分块请求也在流式读取中截断）；
  单 IP 每分钟上限缺省 600，可配。
- **不缓冲**：SSE 逐块回传并置 `X-Accel-Buffering: no`，反代需 `proxy_buffering off;`。

## 7. 验证

- 前端：`pnpm test`（含 `src/game/llm/relayGateway.test.ts`）、`pnpm typecheck`、`pnpm build`。
- 后端：`backend/.venv/Scripts/python.exe -m pytest tests -q`（含 `tests/test_llm_relay.py` 10 条）。
- 端到端（真实 uvicorn + 真实 TCP，非 MockTransport）：
  `tmp/llm-relay-e2e/check_relay.py`（本地假上游每 0.4s 吐一块 SSE）。
  实测：直连假上游正文块 `[0.42, 0.83, 1.23, 1.23]`，经网关（热请求）
  `[0.44, 0.84, 1.27, 1.27]` —— 节奏一致，说明**逐块回传、没有被攒起来**；
  进程启动后的第一次请求会多约 1.6s（建共享 httpx client 等冷启动开销），之后恢复正常。
- 线上：填入真实 `sk-sp-` Key 后点「测试连接」，再开一局带 LLM 座位的对局；
  若失败，先在浏览器 Network 里确认响应来自网关（而非供应商域名），再看后端日志中
  上游返回的状态码。
