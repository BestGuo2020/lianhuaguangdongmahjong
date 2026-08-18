#!/usr/bin/env python3
"""修正版 TURN Allocate 认证。
HMAC 规则（RFC 5769 2.2/2.4 验证）：输入 = 头部（length = 原 length - FINGERPRINT 8 字节，
本请求无 FINGERPRINT 故 = 属性区+MI 长度）+ 到 MI 前所有属性（不含 MI header）。
key = MD5(username:realm:password)。"""
import socket, struct, hashlib, hmac

MAGIC = 0x2112A442

def attr(t, data):
    pad = (4 - len(data) % 4) % 4
    return struct.pack(">HH", t, len(data)) + data + b"\x00" * pad

def stun_header(msg_type, length, txid=b"\x11" * 12):
    return struct.pack(">HHI", msg_type, length, MAGIC) + txid

def parse_stun(raw):
    if len(raw) < 20:
        return {"raw": raw.hex()}
    msg_type, length, _ = struct.unpack(">HHI", raw[:8])
    out = {"type": msg_type, "length": length}
    pos = 20
    end = 20 + length
    while pos + 4 <= end:
        t, l = struct.unpack(">HH", raw[pos:pos + 4])
        data = raw[pos + 4:pos + 4 + l]
        if t == 0x0009 and l >= 4:
            out["error_code"] = struct.unpack(">HBB", data[:4])[2]
            out["error_msg"] = data[4:].decode(errors="replace")
        elif t == 0x0015:
            out["nonce"] = data.decode(errors="replace")
        elif t == 0x0014:
            out["realm"] = data.decode(errors="replace")
        elif t == 0x0020 and l >= 8:
            family, port = struct.unpack(">BH", data[:4])
            ip = socket.inet_ntop(socket.AF_INET if family == 1 else socket.AF_INET6, data[4:4 + (4 if family == 1 else 16)])
            out["relayed"] = f"{ip}:{port}"
        pos += 4 + l + ((4 - l % 4) % 4)
    return out

HOST, PORT = "113.45.254.130", 53478
USER, PASSWORD = "turn", "DZxaEm35GmecFZj"

def make_allocate_with_auth(nonce, realm):
    attrs = (
        attr(0x0019, struct.pack(">B", 17) + b"\x00\x00\x00")   # REQUESTED-TRANSPORT UDP
        + attr(0x0006, USER.encode())                            # USERNAME
        + attr(0x0014, realm.encode())                           # REALM
        + attr(0x0015, nonce.encode())                           # NONCE
    )
    total_length = len(attrs) + 24  # + MI 完整长度（无 FINGERPRINT）
    key = hashlib.md5(f"{USER}:{realm}:{PASSWORD}".encode()).digest()
    msg = stun_header(0x0003, total_length) + attrs  # 不含 MI header
    integrity = hmac.new(key, msg, hashlib.sha1).digest()
    return stun_header(0x0003, total_length) + attrs + attr(0x0008, integrity)

with socket.create_connection((HOST, PORT), timeout=8) as s:
    s.sendall(stun_header(0x0003, 8) + attr(0x0019, struct.pack(">B", 17) + b"\x00\x00\x00"))
    r1 = parse_stun(s.recv(4096))
    print("R1:", r1)
    nonce, realm = r1["nonce"], r1["realm"]
    for attempt in range(3):
        s.sendall(make_allocate_with_auth(nonce, realm))
        r = parse_stun(s.recv(4096))
        print(f"R{attempt + 2}:", r)
        if r.get("type") == 0x0103:
            print("ALLOCATE SUCCESS")
            break
        if r.get("error_code") == 38 and r.get("nonce"):
            nonce = r["nonce"]
            continue
        break
