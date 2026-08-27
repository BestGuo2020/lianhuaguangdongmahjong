# WakuDemo OAuth 2.0 + PKCE 接入

## 目录结构

```text
backend/app/auth/wakudemo.py       PKCE、临时授权请求、服务端 token/session 仓库
backend/app/api/auth.py            登录、回调、会话查询、退出路由
backend/tests/test_wakudemo_auth.py OAuth Mock 测试
src/game/online/api/authApi.ts      前端登录 API（不读取 token）
src/game/online/session/useWakuDemoAuth.ts  Vue 登录状态
src/components/lobby/LobbyView.vue 大厅登录/退出入口
```

浏览器 Cookie 只包含随机 session id，并设置 `HttpOnly`。`state`、PKCE
`code_verifier` 和 `access_token` 均只保存在后端；前端不会读取或持久化 token。

## 配置

复制 `backend/.env.example` 的 WakuDemo 配置到部署环境。审核通过后至少填写：

```dotenv
WAKUDEMO_CLIENT_ID=审核后获得的-client-id
WAKUDEMO_BASE_URL=https://WakuDemo-实际平台域名
WAKUDEMO_REDIRECT_URI=https://www.bestguo.top:58000/api/login/callback
WAKUDEMO_FRONTEND_URL=https://lianhuaguangdongmahjong.guoguo-labs.online/
```

`WAKUDEMO_BASE_URL` 只填写 origin，不带末尾 `/`。回调地址必须与平台登记值逐字一致。

WebView 和浏览器对第三方 Cookie 的策略可能不同。最稳妥的生产部署是让游戏页面与
`/api/login/*` 经反向代理保持同源；若必须分域，需保留 `SameSite=None; Secure`，并确认
目标 WebView 允许跨站 Cookie，否则回调成功后前端可能读不到登录会话。

当前服务端会话是进程内存存储：重启会安全地使用户退出，不会把 token 下发给浏览器。
生产环境先保持单个 Uvicorn worker；如改为多 worker/多实例，应把 pending、used-code、
session 三个存储换成带 TTL 的 Redis，并保持现有 API 不变。

## 启动

后端：

```powershell
cd backend
.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

前端：

```powershell
pnpm dev
```

若前端不与后端同源，在根目录 `.env` 配置：

```dotenv
VITE_API_BASE=http://localhost:8000
```

## 本地测试

不需要 Client ID 的自动化测试（Token 与账户接口均由 `httpx.MockTransport` 模拟）：

```powershell
cd backend
.venv\Scripts\python.exe -m pytest tests/test_wakudemo_auth.py -q
```

真实平台联调需要 WakuDemo 临时登记本地回调地址；如果平台只允许正式回调地址，
应在正式 HTTPS 测试环境联调，不要修改或伪造回调。允许本地回调时配置：

```dotenv
WAKUDEMO_REDIRECT_URI=http://localhost:8000/api/login/callback
WAKUDEMO_FRONTEND_URL=http://localhost:5173/
WAKUDEMO_COOKIE_SAMESITE=lax
WAKUDEMO_COOKIE_SECURE=false
```

检查步骤：

1. 打开 `http://localhost:5173`，点击“WakuDemo 账号 → 登录”。
2. 授权页应包含 `response_type=code`、`scope=account.read` 和 `code_challenge_method=S256`。
3. 同意后应返回大厅并显示 WakuDemo 昵称；取消则显示“已取消授权”。
4. 浏览器的 localStorage/sessionStorage 中不应出现 access token 或 code verifier。
5. 重复打开同一个 callback URL，应返回“一次性凭据已使用/请求已过期”，不会再次换取 token。

## 接口

```text
GET  /api/login/wakudemo   创建 state + PKCE 并跳转授权页
GET  /api/login/callback   校验 state，服务端换 token 并拉取账户
GET  /api/login/session    仅返回登录状态和最小账户资料
POST /api/login/logout     删除服务端 token/session 并清 Cookie
```

错误通过回跳参数 `wakudemo_error` 使用固定错误码传递，不包含授权码、token 或平台响应正文。
