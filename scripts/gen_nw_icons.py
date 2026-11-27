#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
New World (NW) — 纯标准库图标光栅化器
无第三方依赖, 直接把 NW logo 几何 (六边形框 + NW 笔画 + 辉光) 渲染成 RGBA PNG,
再封装为 Windows .ico / macOS .icns / Linux icon.png。

几何与 resources/icon-source.svg 保持一致。
用法: python3 scripts/gen_nw_icons.py
"""
import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "resources"

# ---- palette (linear-ish interpolation between cyan and violet) ----
CYAN = (0x3E, 0xE6, 0xFF)
VIOLET = (0xA7, 0x8B, 0xFA)
BG_TOP = (0x05, 0x06, 0x0C)
BG_BOT = (0x0D, 0x11, 0x20)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def nw_color(x, y):
    """渐变: 左上青 → 右下紫"""
    t = max(0.0, min(1.0, (x + y) / 2.0))
    return lerp(CYAN, VIOLET, t)


def dist_point_seg(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    if l2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def point_in_hex(px, py, cx, cy, r):
    """正六边形(尖顶)内外判定, 用 6 条边的叉积符号"""
    pts = [
        (cx, cy - r),
        (cx + r * 0.866, cy - r * 0.5),
        (cx + r * 0.866, cy + r * 0.5),
        (cx, cy + r),
        (cx - r * 0.866, cy + r * 0.5),
        (cx - r * 0.866, cy - r * 0.5),
    ]
    sign = 0
    for i in range(6):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % 6]
        cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)
        if cross > 0:
            s = 1
        elif cross < 0:
            s = -1
        else:
            continue
        if sign == 0:
            sign = s
        elif s != sign:
            return False
    return True


# NW 笔画(归一化 512 坐标), stroke ≈ 26px, round cap/join
N_STROKES = [
    [(158, 322), (158, 190), (224, 268), (224, 190)],
    [(354, 190), (300, 322), (246, 190)],
]
HEX_POINTS = [
    (256, 52), (428, 154), (428, 358), (256, 460), (84, 358), (84, 154),
]


def render_rgba(size):
    """渲染 size×size 的 RGBA 像素 (bytes), 4x 超采样抗锯齿"""
    SS = 3  # 每像素 3x3 采样
    scale = size / 512.0
    px = bytearray()
    c1, c2 = CYAN, VIOLET
    stroke_w = 26 * scale
    hex_w = 7 * scale
    core_r = 12 * scale

    # 预计算笔画段 (像素坐标)
    segs = []
    for path in N_STROKES:
        for i in range(len(path) - 1):
            segs.append((
                path[i][0] * scale, path[i][1] * scale,
                path[i + 1][0] * scale, path[i + 1][1] * scale,
            ))
    hexs = [(x * scale, y * scale) for x, y in HEX_POINTS]

    for py in range(size):
        for pxx in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]  # r,g,b,a 累加
            for sy in range(SS):
                for sx in range(SS):
                    subx = pxx + (sx + 0.5) / SS
                    suby = py + (sy + 0.5) / SS
                    r, g, b, a = 0, 0, 0, 0

                    # 圆角矩形底 (rx=104)
                    rx = 104 * scale
                    inside = True
                    cx = min(max(subx, rx), size - rx)
                    cy = min(max(suby, rx), size - rx)
                    if math.hypot(subx - cx, suby - cy) > rx:
                        inside = False
                    if inside:
                        t = suby / size
                        r, g, b = lerp(BG_TOP, BG_BOT, t)
                        a = 255

                    if a:
                        # 六边形框 (描边)
                        hd = min(
                            dist_point_seg(subx, suby, hexs[i][0], hexs[i][1], hexs[(i + 1) % 6][0], hexs[(i + 1) % 6][1])
                            for i in range(6)
                        )
                        if hd <= hex_w / 2 + 2 * scale:
                            col = nw_color(subx / size, suby / size)
                            blend = 0.55 if hd > hex_w / 2 else 1.0
                            r = int(r * (1 - blend) + col[0] * blend)
                            g = int(g * (1 - blend) + col[1] * blend)
                            b = int(b * (1 - blend) + col[2] * blend)

                        # NW 笔画 (辉光 + 主体)
                        sd = min(
                            dist_point_seg(subx, suby, ax, ay, bx, by)
                            for ax, ay, bx, by in segs
                        )
                        glow = stroke_w * 1.1
                        if sd <= stroke_w / 2:
                            col = nw_color(subx / size, suby / size)
                            r, g, b = col
                        elif sd <= glow:
                            # 辉光衰减
                            f = 1.0 - (sd - stroke_w / 2) / (glow - stroke_w / 2)
                            f = f * f * 0.45
                            col = nw_color(subx / size, suby / size)
                            r = int(r * (1 - f) + col[0] * f)
                            g = int(g * (1 - f) + col[1] * f)
                            b = int(b * (1 - f) + col[2] * f)

                        # 核心点
                        cd = math.hypot(subx - 256 * scale, suby - 256 * scale)
                        if cd <= core_r:
                            r, g, b = CYAN

                    acc[0] += r; acc[1] += g; acc[2] += b; acc[3] += a
            n = SS * SS
            px.extend((int(acc[0] / n), int(acc[1] / n), int(acc[2] / n), int(acc[3] / n)))
    return bytes(px)


def png_chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    crc = zlib.crc32(tag + data) & 0xFFFFFFFF
    return c + struct.pack(">I", crc)


def make_png(size, rgba):
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # RGBA
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter none
        raw.extend(rgba[y * stride:(y + 1) * stride])
    idat = zlib.compress(bytes(raw), 9)
    return sig + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", idat) + png_chunk(b"IEND", b"")


def make_ico(pngs):
    """pngs: list of (size, png_bytes). ICO 可内嵌 PNG"""
    n = len(pngs)
    header = struct.pack("<HHH", 0, 1, n)
    offset = 6 + 16 * n
    entries = b""
    data = b""
    for size, png in pngs:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png), offset)
        data += png
        offset += len(png)
    return header + entries + data


def make_icns(pngs):
    """ICNS: 每个尺寸一个 ic07/ic08/ic09/ic0a/ic0b/ic0c 型 PNG 块"""
    types = {16: b"icp4", 32: b"icp5", 64: b"icp6", 128: b"ic07", 256: b"ic08", 512: b"ic09"}
    body = b""
    for size, png in pngs:
        t = types.get(size)
        if not t:
            continue
        body += t + struct.pack(">I", len(png) + 8) + png
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def main():
    sizes = [16, 32, 48, 64, 128, 256, 512]
    pngs = []
    for sz in sizes:
        rgba = render_rgba(sz)
        png = make_png(sz, rgba)
        (RES / f"icon-{sz}.png").write_bytes(png)
        pngs.append((sz, png))
        print(f"  icon-{sz}.png  ({len(png)} bytes)")
    (RES / "icon.png").write_bytes(dict(pngs)[512])
    print(f"  icon.png       (512x512)")

    ico = make_ico([(s, p) for s, p in pngs if s in (16, 32, 48, 64, 128, 256)])
    (RES / "icon.ico").write_bytes(ico)
    print(f"  icon.ico       ({len(ico)} bytes)")

    icns = make_icns(pngs)
    (RES / "icon.icns").write_bytes(icns)
    print(f"  icon.icns      ({len(icns)} bytes)")
    print("✅ NW icons generated")


if __name__ == "__main__":
    main()
