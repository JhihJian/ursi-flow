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
    sec = 1,
  } = {},
) {
  const h = Buffer.alloc(16),
    view = new DataView(h.buffer)
  for (const [i, n] of [sec, fraction, captured, original].entries())
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
      assert.equal(rows.length, 1)
      const { layers, ...row } = rows[0]
      assert.deepEqual(
        layers.map((l) => l.name),
        ['SLL2', 'VLAN', 'IPv4', 'UDP'],
      )
      for (const [i, label, value, start, length] of [
        [0, '接口索引', '256', 4, 4],
        [1, 'EtherType', '0x0800', 22, 2],
        [2, '源地址', '192.0.2.1', 36, 4],
        [3, '目的端口', '443', 46, 2],
      ]) {
        assert.deepEqual(
          layers[i].fields.find((f) => f.label === label),
          { label, value, start, length },
        )
      }
      assert.deepEqual(row, {
        number: 1,
        relativeTime: 0,
        bytes: Uint8Array.from(frame),
        summary: '1024 → 443 UDP Len=0',
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
      })
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
  assert.ok(rows.every((r) => !r.layers.some((l) => l.name === 'UDP')))
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

test('仅保留独立的前 512 字节，相对时间支持跨秒和纳秒精度', async () => {
  const a = Buffer.alloc(600, 0xab),
    b = Buffer.alloc(700, 0xcd)
  for (const nano of [true, false]) {
    const units = nano ? 1e9 : 1e6
    const { rows } = await parse(
      Buffer.concat([
        header({ nano }),
        record(a, { sec: 1700000000, fraction: units - 1 }),
        record(b, { sec: 1700000001, fraction: 0 }),
        record(a.subarray(0, 3), { sec: 1700000000, fraction: units - 3 }),
      ]),
    )
    assert.deepEqual(
      rows.map((r) => r.relativeTime),
      [0, 1 / units, -2 / units],
    )
    assert.deepEqual(
      rows.map((r) => r.bytes),
      [a, b, a.subarray(0, 3)].map((buf) =>
        Uint8Array.from(buf.subarray(0, 512)),
      ),
    )
    assert.equal(rows[0].bytes.buffer.byteLength, 512)
    assert.notEqual(rows[0].bytes.buffer, rows[1].bytes.buffer)
    assert.deepEqual(rows[2].layers, [])
  }
})

function tcp(payload, port = 4321) {
  const header = Buffer.alloc(24)
  header.writeUInt16BE(9876)
  header.writeUInt16BE(port, 2)
  header.writeUInt32BE(0xf1234567, 4)
  header.writeUInt32BE(17, 8)
  header[12] = 0x60 // includes four bytes of options
  header[13] = 0x18
  return Buffer.concat([header, Buffer.from(payload)])
}

test('非标准端口也可识别完整可显示的请求行、响应行；偏移越过扩展首部和 TCP 选项', async () => {
  for (const line of [
    'GET /path?q=1 HTTP/1.1',
    'HTTP/1.0 404 Not Found',
    'OPTIONS * HTTP/1.1',
    'CONNECT example.test:443 HTTP/1.1',
  ]) {
    const ext = Buffer.from([6, 0, 0, 0, 0, 0, 0, 0])
    const frame = ip6(
      60,
      Buffer.concat([ext, tcp(`${line}\r\nX-Test: 1\r\n\r\n`)]),
    )
    const {
      rows: [row],
    } = await packets(frame)
    assert.equal(row.protocol, 'HTTP')
    assert.equal(row.summary, line)
    assert.deepEqual(row.ports, [9876, 4321])
    const [sll2, ip, extension, transport, http] = row.layers
    assert.deepEqual(
      [sll2.name, ip.name, extension.name, transport.name, http.name],
      ['SLL2', 'IPv6', 'IPv6 扩展首部 60', 'TCP', 'HTTP'],
    )
    assert.deepEqual(
      transport.fields.find((f) => f.label === 'Flags'),
      { label: 'Flags', value: 'PSH, ACK', start: 80, length: 2 },
    )
    assert.deepEqual(http.fields[0], {
      label: line.startsWith('HTTP/') ? '状态行' : '请求行',
      value: line,
      start: 92,
      length: line.length,
    })
    assert.equal(frame.toString('ascii', 92, 92 + line.length), line)
  }
})

test('截短、跨包、填充、密文及非 HTTP 首行均保留 TCP 摘要，即便端口为 80', async () => {
  const complete = tcp('GET / HTTP/1.1\r\n', 80)
  const frames = [
    ip6(6, complete, complete.length - 1), // LF is outside IP payload
    ip6(6, complete.subarray(0, -1), complete.length), // LF not captured
    ip6(6, tcp('\n', 80)),
    ...[
      '',
      'HTTP/1.1 200 OK\n',
      'GET / HTTP/1.1',
      'GET / HTTP/2.0\r\n',
      'GET /two words HTTP/1.1\r\n',
      'HTTP/1.1 OK\r\n',
      'GET /\t HTTP/1.1\r\n',
      'GET /é HTTP/1.1\r\n',
      'HTTP/1.1 200 bad\x7f\r\n',
      'x\r\nGET / HTTP/1.1\r\n',
      '\x16\x03\x03GET / HTTP/1.1\r\n',
    ].map((p) => ip6(6, tcp(p, 80))),
  ]
  const { rows } = await packets(...frames)
  assert.equal(rows.length, frames.length)
  for (const row of rows) {
    assert.equal(row.protocol, 'TCP')
    assert.equal(row.layers.at(-1).name, 'TCP')
    assert.match(
      row.summary,
      /^9876 → 80 \[PSH, ACK\] Seq=4045620583 Ack=17 Len=/,
    )
  }
  assert.equal(rows[0].summary, rows[1].summary)
})

test('逐字节截短捕获时只描述完整首部，字段范围不超出帧', async () => {
  const request = 'GET / HTTP/1.1\r\n'
  const transport = tcp(request)
  const ip = ip4({ ihl: 6, proto: 6, total: 24 + transport.length }).subarray(
    0,
    24,
  )
  const frame = sll(
    0x8100,
    Buffer.concat([Buffer.from([0, 1, 8, 0]), ip, transport]),
  )
  const { rows } = await packets(
    ...Array.from({ length: frame.length + 1 }, (_, n) => frame.subarray(0, n)),
  )
  assert.equal(rows.length, frame.length + 1)
  for (const [n, row] of rows.entries()) {
    const expected = [
      [20, 'SLL2'],
      [24, 'VLAN'],
      [48, 'IPv4'],
      [72, 'TCP'],
      [frame.length, 'HTTP'],
    ]
    assert.deepEqual(
      row.layers.map((l) => l.name),
      expected.filter(([end]) => end <= n).map(([, name]) => name),
      `cut ${n}`,
    )
    for (const { fields } of row.layers) {
      assert.ok(
        fields.every(
          (f) => f.start >= 0 && f.length > 0 && f.start + f.length <= n,
        ),
        `cut ${n}`,
      )
    }
  }
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
