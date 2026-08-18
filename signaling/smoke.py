#!/usr/bin/env python3
"""信令服务器自检：在进程内起服务器，用两个真实 websockets 客户端验证
join → welcome/房主选举 → offer/answer 中转 → announce/meta。用法：

    python signaling/smoke.py
"""

from __future__ import annotations

import asyncio
import json

import websockets
import websockets.asyncio.client  # noqa: F401 确保 asyncio 客户端子模块加载

import server  # 同目录 server.py


async def recv_json(ws) -> dict:
    raw = await asyncio.wait_for(ws.recv(), timeout=5)
    return json.loads(raw)


async def main() -> None:
    sig = server.SignalingServer()
    async with websockets.serve(sig.handler, "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        url = f"ws://127.0.0.1:{port}"

        async with (
            websockets.asyncio.client.connect(url) as host_ws,
            websockets.asyncio.client.connect(url) as client_ws,
        ):
            # 房主先加入 → host = host-peer
            await host_ws.send(json.dumps({"type": "join", "roomId": "SMOKE1", "peerId": "host-peer"}))
            welcome_host = await recv_json(host_ws)
            assert welcome_host["type"] == "welcome"
            assert welcome_host["hostId"] == "host-peer"
            assert "client-peer" not in welcome_host["members"]

            # 客户端加入 → 房主收到 peer_join，客户端 hostId 指向房主
            await client_ws.send(json.dumps({"type": "join", "roomId": "SMOKE1", "peerId": "client-peer"}))
            welcome_client = await recv_json(client_ws)
            peer_join = await recv_json(host_ws)
            assert welcome_client["hostId"] == "host-peer", welcome_client
            assert peer_join == {"type": "peer_join", "peerId": "client-peer"}, peer_join

            # offer 中转：client → host
            await client_ws.send(json.dumps({"type": "signal", "to": "host-peer", "data": {"sdp": "offer"}}))
            offer_at_host = await recv_json(host_ws)
            assert offer_at_host == {"type": "signal", "from": "client-peer", "data": {"sdp": "offer"}}, offer_at_host

            # answer 中转：host → client
            await host_ws.send(json.dumps({"type": "signal", "to": "client-peer", "data": {"sdp": "answer"}}))
            answer_at_client = await recv_json(client_ws)
            assert answer_at_client == {"type": "signal", "from": "host-peer", "data": {"sdp": "answer"}}, answer_at_client

            # 房主 announce + 客户端 meta_req
            await host_ws.send(json.dumps({"type": "announce", "meta": {"roomId": "SMOKE1", "hostPeerId": "host-peer", "mode": "east"}}))
            await recv_json(host_ws)  # announce_ok
            await client_ws.send(json.dumps({"type": "meta_req"}))
            meta = await recv_json(client_ws)
            assert meta["type"] == "meta" and meta["meta"]["mode"] == "east", meta

        # 连接关闭 → 房间清空（服务端清理是异步的，轮询等它收尾）
        async with websockets.asyncio.client.connect(url) as ws3:
            await ws3.send(json.dumps({"type": "join", "roomId": "SMOKE2", "peerId": "solo"}))
            await recv_json(ws3)
        for _ in range(50):
            if "SMOKE2" not in sig.rooms:
                break
            await asyncio.sleep(0.02)
        assert "SMOKE2" not in sig.rooms

    print("smoke OK")


if __name__ == "__main__":
    asyncio.run(main())
