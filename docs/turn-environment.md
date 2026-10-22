# TURN 探测与自托管测试的环境配置

探测脚本和公网 selfHost 测试只从进程环境读取 TURN 凭据，没有内置账号、密码或服务器地址。

| 变量 | 用途 |
| --- | --- |
| `TURN_HOST` | TURN 主机名或 IP，不含协议和端口；IPv6 使用不带方括号的地址 |
| `TURN_PORT` | TURN 端口，省略时使用 `3478` |
| `TURN_USERNAME` | TURN 用户名 |
| `TURN_PASSWORD` | TURN 密码 |
| `E2E_SIGNALING_URL` | 公网测试的 `ws://` 或 `wss://` 信令地址 |

在运行命令的同一 PowerShell 窗口中设置自己的私有值。下列值只是占位符，不能连接服务器：

```powershell
$env:TURN_HOST = '<your-turn-host>'
$env:TURN_PORT = '3478'
$env:TURN_USERNAME = '<your-turn-username>'
$env:TURN_PASSWORD = '<your-private-turn-password>'
$env:E2E_SIGNALING_URL = 'wss://signaling.example.invalid'

node scripts/probe-turn.mjs
python scripts/probe_turn_fixed.py

# 前端 dev 已在 5173 运行时：
$env:E2E_SKIP_WEBSERVER = '1'
pnpm exec playwright test tests/e2e/selfhost-relay-switch.spec.ts
```

`probe-turn.mjs` 分别检查 UDP/TCP TURN，`probe_turn_fixed.py` 通过 TCP 检查 TURN Allocate 认证。
探测脚本缺少必填变量或端口无效时会在连接前退出，错误只包含变量名，不包含凭据值。

以下测试共用相同环境变量，缺少配置时明确跳过：

- `selfhost-opening-visual.spec.ts`
- `selfhost-relay-switch.spec.ts`
- `selfhost-settlement-rejoin.spec.ts`
- `selfhost-slow-network-three-humans-one-ai.spec.ts`
- `selfhost-two-humans-two-ai-two-matches.spec.ts`

最后一个测试的 `E2E_LOCAL_MOCK=1` 和 `E2E_LOCAL_SIGNALING=1` 路径仍可在没有公网 TURN 配置时运行。
用户名、密码以及整个查询参数都会分别进行 URL 编码，避免 `&`、`#`、`@` 等字符破坏测试链接。

这些工具读取进程环境，不会自动加载 `.env` 文件。私有配置文件应放在已被忽略的 `.env.*.local` 中，
由本地工具或 CI 注入进程环境。不要用 `VITE_*` 存放测试凭据，否则可能被打包进前端。
测试链接和 Playwright trace 可能包含凭据，只能保存在已忽略的本地测试产物目录，不应提交或公开。

历史文档中的明文凭据和链接已脱敏。普通清理提交不会删除旧 Git 历史中的内容；旧密码应在 TURN
服务器上轮换，历史清理及远端强制更新需另行协调。
