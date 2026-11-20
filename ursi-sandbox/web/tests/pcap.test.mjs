import test from 'node:test'
import assert from 'node:assert/strict'
import { readPcap } from '../src/pcap.ts'

function header({
  little = true,
  nano = false,
  link = 276,
  snaplen = 262144,
} = {}) {
  const bytes = Buffer.alloc(24),
    view = new DataView(bytes.buffer)
  view.setUint32(0, nano ? 0xa1b23c4d : 0xa1b2c3d4, little)
  view.setUint16(4, 2, little)
  view.setUint16(6, 4, little)
  view.setUint32(16, snaplen, little)
  view.setUint32(20, link, little)
  return bytes
}
function record(
  body,
  {
    captured = body.length,
    original = captured,
    little = true,
    fraction = 12345,
  } = {},
) {
  const h = Buffer.alloc(16),
    view = new DataView(h.buffer)
  for (const [i, n] of [1, fraction, captured, original].entries())
    view.setUint32(i * 4, n, little)
  return Buffer.concat([h, body])
}
function sll(ether, payload, type = 4) {
  const h = Buffer.alloc(20)
  h.writeUInt16BE(ether)
  h.writeUInt32BE(256, 4)
  h[10] = type
  return Buffer.concat([h, payload])
}
function ip4({ fragment = 0, proto = 17, total = 28, ihl = 5 } = {}) {
  const ip = Buffer.alloc(28)
  ip[0] = 0x40 | ihl
  ip.writeUInt16BE(total, 2)
  ip.writeUInt16BE(fragment, 6)
  ip[9] = proto
  ip.set([192, 0, 2, 1, 192, 0, 2, 2], 12)
  ip.writeUInt16BE(1024, 20)
  ip.writeUInt16BE(443, 22)
  ip.writeUInt16BE(8, 24)
  return ip
}
function ip6(next, payload, length = payload.length) {
  const h = Buffer.alloc(40)
  h[0] = 0x60
  h.writeUInt16BE(length, 4)
  h[6] = next
  h[23] = 1
  h.set([0x20, 0x01, 0x0d, 0xb8], 24)
  h[39] = 2
  return sll(0x86dd, Buffer.concat([h, payload]))
}
function parse(bytes, step = 7) {
  let pos = 0
  return readPcap(
    new ReadableStream({
      pull(c) {
        if (pos >= bytes.length) return c.close()
        c.enqueue(bytes.subarray(pos, pos + step))
        pos += step
      },
    }),
  )
}
function packets(...frames) {
  return parse(Buffer.concat([header(), ...frames.map((body) => record(body))]))
}

test('跨块读取大小端及两种时间精度，独立解释 SLL2 网络字节序', async () => {
  const frame = sll(0x8100, Buffer.concat([Buffer.from([0, 3, 8, 0]), ip4()]))
  for (const little of [true, false])
    for (const nano of [true, false]) {
      const { rows, end } = await parse(
        Buffer.concat([
          header({ little, nano }),
          record(frame, { little, original: 100 }),
        ]),
        1,
      )
      assert.equal(end, 'eof')
      assert.deepEqual(rows, [
        {
          number: 1,
          offset: 24,
          captured: 52,
          original: 100,
          time: `1970-01-01T00:00:01.${nano ? '000012345' : '012345'}Z`,
          ifindex: 256,
          packetType: 4,
          direction: '发出',
          source: '192.0.2.1',
          destination: '192.0.2.2',
          protocol: 'UDP',
          ports: [1024, 443],
        },
      ])
    }
})

test('IPv4 首片和非首片、IP 总长之后的填充和畸形 IHL 均不产出端口', async () => {
  const { rows } = await packets(
    ...[
      { fragment: 0x2000 },
      { fragment: 7 },
      { total: 20 },
      { ihl: 15 },
      { ihl: 4 },
    ].map((args) => sll(0x0800, ip4(args))),
  )
  assert.equal(rows.length, 5)
  assert.ok(rows.every((r) => !r.ports && r.note))
  assert.match(rows[0].note, /分片/)
  assert.match(rows[1].note, /分片/)
})

test('IPv6 扩展首部后的 TCP，分片、截短扩展和无效 TCP 首部', async () => {
  const tcp = Buffer.alloc(20)
  tcp[12] = 0x50
  tcp.writeUInt16BE(42)
  tcp.writeUInt16BE(443, 2)
  const extension = Buffer.from([6, 0, 0, 0, 0, 0, 0, 0])
  const data = Buffer.concat([extension, tcp])
  const { rows } = await packets(
    ip6(60, data),
    ip6(44, data),
    ip6(60, data, 1),
    ip6(6, tcp, 4),
    ip6(6, Buffer.alloc(20)),
  )
  assert.deepEqual(
    [rows[0].protocol, rows[0].source, rows[0].destination, rows[0].ports],
    ['TCP', '::1', '2001:db8::2', [42, 443]],
  )
  assert.ok(rows.slice(1).every((r) => !r.ports && r.note))
  assert.match(rows[1].protocol, /分片/)
})

test('未知协议、包类型和不完整的内层首部不吞掉后续记录，回环收发不合并', async () => {
  const ip = ip4({ proto: 253 })
  const { rows, end } = await packets(
    sll(0x1234, Buffer.alloc(0), 99),
    Buffer.alloc(3),
    sll(0x0800, ip, 0),
    sll(0x0800, ip, 4),
  )
  assert.equal(end, 'eof')
  assert.deepEqual(
    rows.map((r) => r.protocol),
    ['EtherType 0x1234', '未知', 'IP 协议 253', 'IP 协议 253'],
  )
  assert.deepEqual(
    rows.map((r) => r.direction),
    ['包类型 99', '未知', '本机接收', '发出'],
  )
})

test('每个可能的 EOF 位置：区分文件头、空段、完整前缀和截尾，并报告偏移', async () => {
  const r = record(sll(0x0800, ip4())),
    bytes = Buffer.concat([header(), r, r])
  for (let i = 0; i <= bytes.length; i++) {
    const { rows, end, message } = await parse(bytes.subarray(0, i), 13)
    const clean = i >= 24 && (i - 24) % r.length === 0
    assert.equal(end, clean ? 'eof' : 'truncated', `cut ${i}`)
    assert.equal(rows.length, Math.max(0, Math.floor((i - 24) / r.length)))
    if (!clean) assert.match(message, new RegExp(`偏移 ${i} 处`))
  }
})

test('长度越过 snaplen、安全上限或原始长度时拒绝记录，不尝试分配或等待声明的长度', async () => {
  const first = record(sll(0x0800, ip4()))
  for (const [snaplen, fields] of [
    [128, { captured: 129 }],
    [0xffffffff, { captured: 0xffffffff }],
    [128, { captured: 40, original: 39 }],
    [128, { fraction: 1e6 }],
  ]) {
    const res = await parse(
      Buffer.concat([
        header({ snaplen }),
        first,
        record(Buffer.alloc(0), fields),
      ]),
    )
    assert.equal(res.end, 'invalid')
    assert.equal(res.rows.length, 1)
    assert.match(res.message, new RegExp(`偏移 ${24 + first.length}`))
  }
  await assert.rejects(parse(header({ link: 1 })), /SLL2/)
  await assert.rejects(parse(Buffer.alloc(24)), /PCAP/)
})

test('第 500 条完成即取消源流，不读取或等待第 501 条', async () => {
  const r = record(sll(0x0800, ip4())),
    prefix = Buffer.concat([header(), ...Array(500).fill(r)])
  let pulls = 0,
    cancels = 0
  const stream = new ReadableStream(
    {
      pull(c) {
        assert.equal(++pulls, 1, 'preview read past the cap')
        c.enqueue(prefix)
      },
      cancel() {
        cancels++
      },
    },
    { highWaterMark: 0 },
  )
  const res = await readPcap(stream)
  assert.equal(res.end, 'limit')
  assert.equal(res.rows.at(-1).number, 500)
  assert.equal(cancels, 1)
  assert.equal(stream.locked, false)
})
