#!/usr/bin/env python3
"""莲花广麻 · 自托管 P2P 信令服务器（握手服务器）。

职责：只做「握手」——房间成员、房主选举、SDP offer/answer 与 ICE candidate 的中转、
房间元数据（announce/meta）。不参与游戏逻辑，不转发业务消息（业务消息走 WebRTC
DataChannel，房主权威引擎仍在浏览器里跑）。

协议（JSON over WebSocket）：

客户端 → 服务器
  { "type": "join",     "roomId": "ABC123", "peerId?": "p-xxx" }
  { "type": "signal",   "to": "<peerId>", "data": { ...offer/answer/ice... } }
  { "type": "announce", "meta": { ...RoomMetadata... } }        # 仅房主
  { "type": "meta_req" }
  { "type": "leave" }

服务器 → 客户端
  { "type": "welcome", "peerId", "roomId", "hostId", "members": [...] }
  { "type": "peer_join", "peerId" }
  { "type": "peer_leave", "peerId", "hostId" }
  { "type": "signal",   "from": "<peerId>", "data": { ... } }
  { "type": "meta",     "meta": { ...RoomMetadata... } | null }
  { "type": "announce_ok" }
  { "type": "error",    "message": "..." }

房主 = 每个房间第一个加入的成员；房主离开后按加入顺序把 host 移交给下一位（应用层
自身有「不伪造新权威」的守卫，客户端会拒绝接受换主后的状态，因此这里只是尽力而为）。

运行：
  python signaling/server.py --host 0.0.0.0 --port 8787
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import uuid
from collections import OrderedDict
from typing import Any, Dict, Optional

import websockets
from websockets.server import WebSocketServerProtocol

log = logging.getLogger("signaling")


class Room:
    def __init__(self, room_id: str) -> None:
        self.room_id = room_id
        # 保持加入顺序，host = 第一个仍在线的成员。
        self.members: "OrderedDict[str, WebSocketServerProtocol]" = OrderedDict()
        self.meta: Optional[Dict[str, Any]] = None

    @property
    def host_id(self) -> Optional[str]:
        return next(iter(self.members), None)


class SignalingServer:
    def __init__(self) -> None:
        self.rooms: Dict[str, Room] = {}
        self.lock = asyncio.Lock()

    @staticmethod
    async def _send(ws: WebSocketServerProtocol, obj: Dict[str, Any]) -> None:
        try:
            await ws.send(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
        except Exception as exc:  # 对端已断开等
            log.debug("send failed: %s", exc)

    async def _broadcast(
        self,
        room: Room,
        obj: Dict[str, Any],
        exclude: Optional[str] = None,
    ) -> None:
        for peer_id, ws in list(room.members.items()):
            if peer_id == exclude:
                continue
            await self._send(ws, obj)

    async def _handle_join(
        self,
        ws: WebSocketServerProtocol,
        msg: Dict[str, Any],
    ) -> tuple[Optional[str], Optional[str]]:
        """返回 (room_id, peer_id)；后续消息据此路由。"""
        raw_room = msg.get("roomId")
        room_id = str(raw_room).strip().upper() if raw_room is not None else ""
        if not room_id:
            await self._send(ws, {"type": "error", "message": "缺少 roomId"})
            return None, None
        raw_peer = msg.get("peerId")
        peer_id = str(raw_peer).strip() if raw_peer is not None else ""
        if not peer_id:
            peer_id = "p-" + uuid.uuid4().hex[:12]

        async with self.lock:
            room = self.rooms.setdefault(room_id, Room(room_id))
            room.members[peer_id] = ws
            host_id = room.host_id
            members = list(room.members.keys())

        await self._send(ws, {
            "type": "welcome",
            "peerId": peer_id,
            "roomId": room_id,
            "hostId": host_id,
            "members": members,
        })
        await self._broadcast(room, {"type": "peer_join", "peerId": peer_id}, exclude=peer_id)
        return room_id, peer_id

    async def handler(self, ws: WebSocketServerProtocol) -> None:
        room_id: Optional[str] = None
        peer_id: Optional[str] = None
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                if not isinstance(msg, dict):
                    continue
                mtype = msg.get("type")

                if mtype == "join":
                    room_id, peer_id = await self._handle_join(ws, msg)
                elif mtype == "signal":
                    to = str(msg.get("to", "")).strip()
                    data = msg.get("data")
                    if not room_id or not peer_id or not to:
                        continue
                    async with self.lock:
                        room = self.rooms.get(room_id)
                        target = room.members.get(to) if room else None
                    if target is not None:
                        await self._send(target, {"type": "signal", "from": peer_id, "data": data})
                elif mtype == "announce":
                    if not room_id or not peer_id:
                        continue
                    async with self.lock:
                        room = self.rooms.get(room_id)
                        if room is not None and room.host_id == peer_id:
                            room.meta = msg.get("meta")
                    await self._send(ws, {"type": "announce_ok"})
                elif mtype == "meta_req":
                    if not room_id:
                        continue
                    async with self.lock:
                        room = self.rooms.get(room_id)
                        meta = room.meta if room else None
                    await self._send(ws, {"type": "meta", "meta": meta})
                elif mtype == "leave":
                    break
        except websockets.ConnectionClosed:
            pass
        finally:
            if room_id and peer_id:
                async with self.lock:
                    room = self.rooms.get(room_id)
                    if room is not None:
                        if room.members.pop(peer_id, None) is not None:
                            if not room.members:
                                self.rooms.pop(room_id, None)
                            else:
                                await self._broadcast(room, {
                                    "type": "peer_leave",
                                    "peerId": peer_id,
                                    "hostId": room.host_id,
                                })


async def main(host: str, port: int) -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    server = SignalingServer()
    log.info("信令服务器监听 ws://%s:%d", host, port)
    async with websockets.serve(server.handler, host, port, max_size=2 ** 20):
        await asyncio.Future()  # 一直运行


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="莲花广麻 P2P 信令服务器")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    try:
        asyncio.run(main(args.host, args.port))
    except KeyboardInterrupt:
        pass
