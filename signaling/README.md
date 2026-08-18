# 莲花广麻 · 自托管 P2P 测试环境（信令 + TURN + 薄 WebRTC 传输层）

不上线，用真实 WebRTC / 真实网络联调 P2P 对局。三件套：

| 组件 | 文件 | 作用 |
|---|---|---|
| 信令服务器（握手） | `server.py` | 房间成员、房主选举、SDP/ICE 中转、房间元数据 |
| TURN/STUN 中继 | `coturn/turnserver.conf` | NAT 打洞失败时兜底中继 |
| 前端薄传输层 | `src/game/online/transport/selfHost/` | 实现与 `VibeHubSDK.Room/Client` 同形接口，替换 mock/真实 SDK |

业务消息仍走 WebRTC DataChannel，房主权威引擎仍在浏览器里跑，服务器不碰游戏逻辑。

---

## 一、本机快速开始（最快，测传输层 + 完整对局逻辑）

本机 `localhost` 是浏览器认可的安全上下文，WebRTC 可用，无需 HTTPS / TURN。

1. 起信令服务器（任选其一）：

   ```bash
   # 方式 A：用仓库里现成的后端 venv
   backend/.venv/Scripts/python.exe signaling/server.py

   # 方式 B：自己装依赖后跑
   python -m venv .venv && .venv/Scripts/pip install -r signaling/requirements.txt
   .venv/Scripts/python.exe signaling/server.py
   ```

   默认监听 `ws://0.0.0.0:8787`。

2. 起前端 dev：

   ```bash
   pnpm dev
   ```

3. 开 **4 个不同的浏览器 profile**（或同一浏览器 4 个窗口），都访问：

   ```
   http://localhost:5173/?selfHost=ws://127.0.0.1:8787
   ```

   一个建房、其余凭 6 位房号加入，即可跑完整四人对局（入座/准备/洗牌/摸打碰杠胡/翻精/结算/下一局/刷新重进）。

> 为什么不能用同一个 profile 的 4 个标签页？`?selfHost` 每个页面是独立 WebRTC
> peer，但同一 profile 共享 localStorage，应用层会话/战绩会互相污染。用不同
> profile（或 Chrome 多用户 / 无痕窗口）最干净。

### 本机自检

```bash
backend/.venv/Scripts/python.exe signaling/smoke.py   # 信令协议自检，应打印 smoke OK
pnpm test                                             # 前端测试（含 selfHost 传输层单测）
```

---

## 二、云服务器 + 跨设备真实网络（测 NAT / TURN / 打洞）

本机 loopback 测不出对称 NAT、运营商级 NAT、TURN 中继这些真实网络问题。上云：

1. **改 `coturn/turnserver.conf`**：`realm`、`user=turn:密码`、`external-ip=云服务器公网IP`。

2. **起服务**：

   ```bash
   cd signaling
   docker compose up -d --build
   ```

   安全组放行：`8787/tcp`、`3478/udp+tcp`、`5349/udp+tcp`、`49152-65535/udp`。

3. **HTTPS + wss**（WebRTC 要求安全上下文，跨设备必须 HTTPS）：

   - 用 Caddy 最省事：把 `Caddyfile` 的域名改成你的，`docker run -d -p 80:80 -p 443:443 -v $PWD/Caddyfile:/etc/caddy/Caddyfile -v $PWD/../dist:/srv/www/lianhua caddy:latest`
   - 或 nginx：反代 `/signal` → `127.0.0.1:8787`（开 WebSocket upgrade），静态托管 `dist/`。

4. **真机访问**（手机 / 同事电脑 / 不同网络的浏览器）：

   ```
   https://your.domain.example.com/?selfHost=wss://your.domain.example.com/signal&turn=turn:user:密码@your.domain.example.com:3478
   ```

   这样 4 台设备走真实公网：能打洞就 P2P 直连，打不通就 coturn 中继。

---

## 三、配置参数

| 参数 | 说明 |
|---|---|
| `?selfHost=ws://…` / `VITE_SELF_HOST_SIGNALING` | 信令地址（**必填**，否则回退 mock/真实 SDK） |
| `?turn=turn:user:pass@host:port` / `VITE_TURN_SERVER` | TURN 中继（可选，跨设备打洞失败时兜底） |
| `?stun=stun:host:port` / `VITE_STUN_SERVER` | 自定义 STUN（不传用公共 STUN） |
| `?selfHostPeer=p-xxx` | 固定 peerId（重连测试用，默认每次连接随机） |

优先级：URL 查询参数 > 环境变量。

---

## 四、与内置 mock 的区别

| | mock（BroadcastChannel） | 自托管传输层 |
|---|---|---|
| 传输 | 同源窗口间模拟，可靠有序 | 真实 WebRTC DataChannel |
| 信令 | 无（伪造房主选举） | 真实 SDP/ICE 握手 |
| NAT / TURN | 无 | 真实（公共 STUN + coturn） |
| 跨设备 | 不支持 | 支持 |
| 建连前首条消息丢失 / 延迟 / 打洞失败 | 无 | 真实发生 |

**当前限制（v1）**：不实现 SDK 的自动 relay 切换与断线重连（连接断开会直接按 `leave` 处理，
应用层已有房主失联/AI 接管兜底）；无主机迁移（房主刷新即结束，与生产一致）；无登录
（`login()` 返回本机身份，DEV/自托管本不强制登录）。

---

## 五、常见问题

- **`?selfHost` 没生效 / 又走了 mock**：信令地址必须以 `ws://`/`wss://` 开头，否则被忽略。
- **本机没问题、真机连不上**：多半是没走 HTTPS（非 localhost 的 http 不是安全上下文，
  `RTCPeerConnection` 不存在）；或 coturn 的 `external-ip` 没填、安全组没放行 UDP。
- **能建房但加不进/没座位**：看信令服务器控制台有没有 `peer_join`；再看浏览器 console
  的 `[selfHost]` 日志（offer/answer/ICE 失败会打 warn）。
- **打洞总是走 TURN**：正常。对称 NAT 两端打洞本就大概率失败，这正是要上 TURN 的原因。
- **HTTP 页面 + ws 信令**：本机 `http://localhost` + `ws://127.0.0.1` 可用；但 HTTPS 页面
  只能用 `wss://`（混合内容会被浏览器拦）。

---

## 六、回退方式

删掉 URL 里的 `?selfHost=`（并清掉 `VITE_SELF_HOST_SIGNALING`）即恢复原有行为：
DEV 用 mock，生产构建走真实 VibeHub SDK。自托管传输层是纯增量，不影响 `sync:vibehub`。
