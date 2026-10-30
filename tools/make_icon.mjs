/**
 * 生成「诗画溧水·水韵慢城 · 离线演示台」应用图标（.ico），零第三方依赖。
 *
 * 视觉与项目一致：水墨米白底 + 赭红路线 + 淡墨山形。
 * 输出多尺寸 ICO（16/32/48/64 用 32bpp DIB，256 用 PNG 压缩），
 * 便于 Windows 桌面快捷方式在各处清晰显示。
 *
 * 用法：
 *   node tools/make_icon.mjs <out.ico> [preview.png]
 */

import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const OUT_ICO = process.argv[2] || 'lishui-trail.ico'
const OUT_PNG = process.argv[3] || ''

/* ------------------------------ 调色 ------------------------------ */
const CREAM = [245, 241, 232]
const EDGE = [214, 206, 192]
const MTN_FAR = [168, 174, 166]
const MTN_NEAR = [142, 148, 140]
const RED = [166, 58, 44]

/* --------------------------- 超采样渲染 --------------------------- */
const BASE = 64 // 逻辑坐标基准边长

function makeCtx(S) {
  const buf = new Float32Array(S * S * 4)
  const u = S / BASE

  const blend = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return
    const i = (y * S + x) * 4
    const sa = a / 255
    const ia = 1 - sa
    buf[i] = buf[i] * ia + r * sa
    buf[i + 1] = buf[i + 1] * ia + g * sa
    buf[i + 2] = buf[i + 2] * ia + b * sa
    buf[i + 3] = buf[i + 3] * ia + 255 * sa
  }

  const disk = (cx, cy, rad, col, a = 255) => {
    const x0 = Math.max(0, Math.floor(cx - rad))
    const x1 = Math.min(S - 1, Math.ceil(cx + rad))
    const y0 = Math.max(0, Math.floor(cy - rad))
    const y1 = Math.min(S - 1, Math.ceil(cy + rad))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx
        const dy = y + 0.5 - cy
        if (dx * dx + dy * dy <= rad * rad) blend(x, y, col[0], col[1], col[2], a)
      }
    }
  }

  const roundRect = (x0, y0, x1, y1, r, col, a = 255) => {
    const X0 = x0 * u
    const Y0 = y0 * u
    const X1 = x1 * u
    const Y1 = y1 * u
    const R = r * u
    const px0 = Math.max(0, Math.floor(X0))
    const px1 = Math.min(S - 1, Math.ceil(X1))
    const py0 = Math.max(0, Math.floor(Y0))
    const py1 = Math.min(S - 1, Math.ceil(Y1))
    for (let y = py0; y <= py1; y++) {
      for (let x = px0; x <= px1; x++) {
        const cx = x + 0.5
        const cy = y + 0.5
        if (cx < X0 || cx > X1 || cy < Y0 || cy > Y1) continue
        // 圆角判定
        const qx = cx < X0 + R ? X0 + R : cx > X1 - R ? X1 - R : cx
        const qy = cy < Y0 + R ? Y0 + R : cy > Y1 - R ? Y1 - R : cy
        const dx = cx - qx
        const dy = cy - qy
        if (dx * dx + dy * dy > R * R) continue
        blend(x, y, col[0], col[1], col[2], a)
      }
    }
  }

  const tri = (p1, p2, p3, col, a = 255) => {
    const P = [p1, p2, p3].map(([x, y]) => [x * u, y * u])
    const xs = P.map((p) => p[0])
    const ys = P.map((p) => p[1])
    const px0 = Math.max(0, Math.floor(Math.min(...xs)))
    const px1 = Math.min(S - 1, Math.ceil(Math.max(...xs)))
    const py0 = Math.max(0, Math.floor(Math.min(...ys)))
    const py1 = Math.min(S - 1, Math.ceil(Math.max(...ys)))
    const sign = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy)
    for (let y = py0; y <= py1; y++) {
      for (let x = px0; x <= px1; x++) {
        const cx = x + 0.5
        const cy = y + 0.5
        const d1 = sign(cx, cy, P[0][0], P[0][1], P[1][0], P[1][1])
        const d2 = sign(cx, cy, P[1][0], P[1][1], P[2][0], P[2][1])
        const d3 = sign(cx, cy, P[2][0], P[2][1], P[0][0], P[0][1])
        const neg = d1 < 0 || d2 < 0 || d3 < 0
        const pos = d1 > 0 || d2 > 0 || d3 > 0
        if (neg && pos) continue
        blend(x, y, col[0], col[1], col[2], a)
      }
    }
  }

  const stroke = (pts, w, col, a = 255) => {
    const rad = (w * u) / 2
    const P = pts.map(([x, y]) => [x * u, y * u])
    for (let i = 0; i + 1 < P.length; i++) {
      const [x0, y0] = P[i]
      const [x1, y1] = P[i + 1]
      const len = Math.hypot(x1 - x0, y1 - y0)
      const steps = Math.max(1, Math.ceil(len / (u * 0.35)))
      for (let s = 0; s <= steps; s++) {
        const t = s / steps
        disk(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, rad, col, a)
      }
    }
  }

  return { S, u, buf, roundRect, tri, stroke, disk }
}

function drawIcon(ctx) {
  // 底板：先画一圈浅边，再叠米白内板，形成细描边
  ctx.roundRect(1.5, 1.5, 62.5, 62.5, 13.5, EDGE)
  ctx.roundRect(2.7, 2.7, 61.3, 61.3, 12.6, CREAM)

  // 山形（远山浅、近山深）
  ctx.tri([28, 50], [44, 24], [60, 50], MTN_FAR)
  ctx.tri([4, 50], [21, 20], [38, 50], MTN_NEAR)

  // 赭红路线
  ctx.stroke(
    [
      [9, 47],
      [21, 35],
      [32, 41],
      [45, 25],
    ],
    3.4,
    RED
  )

  // 起点（赭红环 + 米白心）
  ctx.disk(9 * ctx.u, 47 * ctx.u, 4.4 * ctx.u, RED)
  ctx.disk(9 * ctx.u, 47 * ctx.u, 2.1 * ctx.u, CREAM)

  // 终点
  ctx.disk(45 * ctx.u, 25 * ctx.u, 3.2 * ctx.u, RED)
  ctx.disk(45 * ctx.u, 25 * ctx.u, 1.4 * ctx.u, CREAM)
}

function render(size, ss) {
  const S = size * ss
  const ctx = makeCtx(S)
  drawIcon(ctx)
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const i = ((y * ss + dy) * S + (x * ss + dx)) * 4
          const pa = ctx.buf[i + 3]
          r += ctx.buf[i] * pa
          g += ctx.buf[i + 1] * pa
          b += ctx.buf[i + 2] * pa
          a += pa
        }
      }
      const n = ss * ss
      const o = (y * size + x) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

/* ------------------------------ 编码 ------------------------------ */
function dib(size, rgba) {
  const xorSize = size * size * 4
  const andRow = (Math.ceil(size / 8) + 3) & ~3
  const andSize = andRow * size
  const buf = Buffer.alloc(40 + xorSize + andSize) // AND 区保持全 0
  buf.writeUInt32LE(40, 0)
  buf.writeInt32LE(size, 4)
  buf.writeInt32LE(size * 2, 8)
  buf.writeUInt16LE(1, 12)
  buf.writeUInt16LE(32, 14)
  buf.writeUInt32LE(0, 16)
  buf.writeUInt32LE(xorSize, 20)
  let p = 40
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      buf[p++] = rgba[i + 2]
      buf[p++] = rgba[i + 1]
      buf[p++] = rgba[i]
      buf[p++] = rgba[i + 3]
    }
  }
  return buf
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  let p = 0
  for (let y = 0; y < size; y++) {
    raw[p++] = 0
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      raw[p++] = rgba[i]
      raw[p++] = rgba[i + 1]
      raw[p++] = rgba[i + 2]
      raw[p++] = rgba[i + 3]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------ 组装 ------------------------------ */
const SIZES_DIB = [16, 32, 48, 64]
const PNG_SIZE = 256

const images = []
for (const s of SIZES_DIB) {
  images.push({ size: s, data: dib(s, render(s, s <= 32 ? 8 : 6)) })
}
const big = render(PNG_SIZE, 3)
images.push({ size: PNG_SIZE, data: png(PNG_SIZE, big) })
if (OUT_PNG) writeFileSync(OUT_PNG, png(256, big))

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)

let offset = 6 + images.length * 16
const entries = []
for (const img of images) {
  const e = Buffer.alloc(16)
  e[0] = img.size >= 256 ? 0 : img.size
  e[1] = img.size >= 256 ? 0 : img.size
  e[2] = 0
  e[3] = 0
  e.writeUInt16LE(1, 4)
  e.writeUInt16LE(32, 6)
  e.writeUInt32LE(img.data.length, 8)
  e.writeUInt32LE(offset, 12)
  entries.push(e)
  offset += img.data.length
}

writeFileSync(OUT_ICO, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]))
console.log(`ico  = ${OUT_ICO}  (${images.map((i) => i.size).join('/')})`)
if (OUT_PNG) console.log(`png  = ${OUT_PNG}`)
