export const PREVIEW_LIMIT = 500
// Observer's per-record capture limit. Never allocate based on an untrusted length.
const MAX_CAPTURE = 262144

const BYTE_PREVIEW = 512
const MAX_HTTP_LINE = 8192

interface PacketField {
  label: string
  value: string
  start: number
  length: number
}

export interface PacketRow {
  number: number
  offset: number
  time: string
  relativeTime: number
  summary: string
  bytes: Uint8Array
  layers: { name: string; fields: PacketField[] }[]
  captured: number
  original: number
  ifindex?: number
  packetType?: number
  direction: string
  protocol: string
  source: string
  destination: string
  ports?: [number, number]
  note?: string
}
export interface PcapPreview {
  rows: PacketRow[]
  end: 'eof' | 'limit' | 'truncated' | 'invalid'
  message?: string
}

const directions = ['本机接收', '广播', '组播', '其他主机', '发出']
const ipProtocols: Record<number, string> = {
  1: 'ICMP',
  6: 'TCP',
  17: 'UDP',
  50: 'ESP',
  58: 'ICMPv6',
  59: '无下一首部',
}
const ipv4 = (v: DataView, at: number) =>
  Array.from({ length: 4 }, (_, i) => v.getUint8(at + i)).join('.')
function ipv6(v: DataView, at: number) {
  const words = Array.from({ length: 8 }, (_, i) =>
    v.getUint16(at + 2 * i).toString(16),
  )
  let start = 0,
    length = 0
  for (let i = 0; i < 8; ) {
    if (words[i] !== '0') {
      i++
      continue
    }
    let j = i + 1
    while (words[j] === '0') j++
    if (j - i > length) {
      start = i
      length = j - i
    }
    i = j
  }
  return length < 2
    ? words.join(':')
    : words.slice(0, start).join(':') +
        '::' +
        words.slice(start + length).join(':')
}

function field(
  label: string,
  value: number | string,
  start: number,
  length: number,
): PacketField {
  return { label, value: String(value), start, length }
}
const hex16 = (n: number) => `0x${n.toString(16).padStart(4, '0')}`
const flagNames = ['FIN', 'SYN', 'RST', 'PSH', 'ACK', 'URG', 'ECE', 'CWR', 'AE']

// Only inspect a bounded, printable start-line terminated inside this TCP payload.
function httpStartLine(v: DataView, start: number, end: number) {
  const limit = Math.min(end, start + MAX_HTTP_LINE)
  for (let i = start; i < limit; i++) {
    const byte = v.getUint8(i)
    if (byte === 13 && i + 1 < limit && v.getUint8(i + 1) === 10) {
      const line = new TextDecoder().decode(
        new Uint8Array(v.buffer, v.byteOffset + start, i - start),
      )
      if (/^HTTP\/1\.\d [1-5]\d\d .*$/.test(line))
        return field('状态行', line, start, i - start)
      const request = /^([\w!#$%&'*+.^`|~-]+) (\S+) HTTP\/1\.\d$/.exec(line)
      if (!request) return
      const [, method, target] = request
      if (!/^(?:[\w.!$&'()*+,;=:@/?~\[\]-]|%[\da-fA-F]{2})+$/.test(target))
        return
      const validTarget =
        method === 'CONNECT'
          ? /^(?:\[[\da-fA-F:.]+\]|[\w.-]+):\d+$/.test(target)
          : target.startsWith('/') ||
            (/^[a-z][a-z\d+.-]*:/i.test(target) && URL.canParse(target)) ||
            (method === 'OPTIONS' && target === '*')
      if (validTarget) return field('请求行', line, start, i - start)
      return
    }
    if (byte < 0x20 || byte > 0x7e) return
  }
}

function decodePacket(row: PacketRow, v: DataView) {
  const layer = (name: string, ...fields: PacketField[]) =>
    row.layers.push({ name, fields })
  const size = v.byteLength
  if (size < 20) {
    row.note = 'SLL2 首部不完整'
    return
  }
  row.ifindex = v.getUint32(4)
  row.packetType = v.getUint8(10)
  row.direction = directions[row.packetType] ?? `包类型 ${row.packetType}`
  let ether = v.getUint16(0),
    at = 20
  layer(
    'SLL2',
    field('EtherType', hex16(ether), 0, 2),
    field('接口索引', row.ifindex, 4, 4),
    field('硬件类型', v.getUint16(8), 8, 2),
    field('包类型', `${row.packetType} (${row.direction})`, 10, 1),
  )
  for (let tags = 0; ether === 0x8100 || ether === 0x88a8; tags++) {
    row.protocol = 'VLAN'
    if (tags === 2 || size < at + 4) {
      row.note = 'VLAN 首部过深或不完整'
      return
    }
    ether = v.getUint16(at + 2)
    layer(
      'VLAN',
      field('VLAN ID', v.getUint16(at) & 0xfff, at, 2),
      field('EtherType', hex16(ether), at + 2, 2),
    )
    at += 4
  }
  let next: number, end: number
  if (ether === 0x0800) {
    row.protocol = 'IPv4'
    if (size < at + 20 || v.getUint8(at) >>> 4 !== 4) {
      row.note = 'IPv4 首部无效或不完整'
      return
    }
    const ihl = (v.getUint8(at) & 15) * 4,
      total = v.getUint16(at + 2)
    if (ihl < 20 || total < ihl || size < at + ihl) {
      row.note = 'IPv4 长度无效或不完整'
      return
    }
    row.source = ipv4(v, at + 12)
    row.destination = ipv4(v, at + 16)
    next = v.getUint8(at + 9)
    end = Math.min(at + total, size)
    const fragment = v.getUint16(at + 6)
    layer(
      'IPv4',
      field('首部长度', ihl, at, 1),
      field('总长度', total, at + 2, 2),
      field('标志和片偏移', hex16(fragment), at + 6, 2),
      field('TTL', v.getUint8(at + 8), at + 8, 1),
      field('协议', next, at + 9, 1),
      field('源地址', row.source, at + 12, 4),
      field('目的地址', row.destination, at + 16, 4),
    )
    if (fragment & 0x3fff) {
      row.protocol = ipProtocols[next] ?? `IP 协议 ${next}`
      row.note = 'IPv4 分片，未解析传输层'
      return
    }
    at += ihl
  } else if (ether === 0x86dd) {
    row.protocol = 'IPv6'
    if (size < at + 40 || v.getUint8(at) >>> 4 !== 6) {
      row.note = 'IPv6 首部无效或不完整'
      return
    }
    row.source = ipv6(v, at + 8)
    row.destination = ipv6(v, at + 24)
    next = v.getUint8(at + 6)
    const payloadLength = v.getUint16(at + 4)
    end = Math.min(at + 40 + payloadLength, size)
    layer(
      'IPv6',
      field('载荷长度', payloadLength, at + 4, 2),
      field('下一首部', next, at + 6, 1),
      field('跳数限制', v.getUint8(at + 7), at + 7, 1),
      field('源地址', row.source, at + 8, 16),
      field('目的地址', row.destination, at + 24, 16),
    )
    at += 40
    for (let count = 0; [0, 43, 60, 51].includes(next); count++) {
      if (count === 8 || at + 2 > end) {
        row.note = 'IPv6 扩展首部过深或不完整'
        return
      }
      const len =
        next === 51
          ? (v.getUint8(at + 1) + 2) * 4
          : (v.getUint8(at + 1) + 1) * 8
      if (len > end - at || (next === 51 && len < 12)) {
        row.note = 'IPv6 扩展首部长度无效'
        return
      }
      const extension = next
      next = v.getUint8(at)
      layer(
        `IPv6 扩展首部 ${extension}`,
        field('下一首部', next, at, 1),
        field('首部长度', len, at + 1, 1),
      )
      at += len
    }
    if (next === 44) {
      row.protocol = 'IPv6 分片'
      row.note = '未重组分片或解析传输层'
      return
    }
  } else if (ether === 0x0806) {
    row.protocol = 'ARP'
    if (
      at + 8 <= size &&
      v.getUint16(at + 2) === 0x0800 &&
      v.getUint8(at + 5) === 4
    ) {
      const hardware = v.getUint8(at + 4)
      if (at + 8 + 2 * (hardware + 4) <= size) {
        row.source = ipv4(v, at + 8 + hardware)
        row.destination = ipv4(v, at + 12 + 2 * hardware)
        layer(
          'ARP',
          field('操作码', v.getUint16(at + 6), at + 6, 2),
          field('发送方 IP', row.source, at + 8 + hardware, 4),
          field('目标 IP', row.destination, at + 12 + 2 * hardware, 4),
        )
        row.summary = `ARP ${row.source} → ${row.destination}`
      }
    }
    return
  } else {
    row.protocol = `EtherType 0x${ether.toString(16).padStart(4, '0')}`
    return
  }
  row.protocol = ipProtocols[next] ?? `IP 协议 ${next}`
  if (next !== 6 && next !== 17) return
  if (at + (next === 6 ? 20 : 8) > end) {
    row.note = '传输层首部不完整'
    return
  }
  const source = v.getUint16(at),
    destination = v.getUint16(at + 2)
  const ports = [
    field('源端口', source, at, 2),
    field('目的端口', destination, at + 2, 2),
  ]
  if (next === 6) {
    const len = (v.getUint8(at + 12) >>> 4) * 4
    if (len < 20 || at + len > end) {
      row.note = 'TCP 首部长度无效或不完整'
      return
    }
    const seq = v.getUint32(at + 4),
      ack = v.getUint32(at + 8)
    const bits = v.getUint16(at + 12) & 0x1ff
    const flags = flagNames.filter((_, i) => bits & (1 << i)).join(', ') || '无'
    const payload = at + len,
      length = end - payload
    layer(
      'TCP',
      ...ports,
      field('序列号', seq, at + 4, 4),
      field('确认号', ack, at + 8, 4),
      field('首部长度', len, at + 12, 1),
      field('Flags', flags, at + 12, 2),
      field('窗口', v.getUint16(at + 14), at + 14, 2),
      ...(length ? [field('已捕获载荷', `${length} B`, payload, length)] : []),
    )
    row.summary = `${source} → ${destination} [${flags}] Seq=${seq}${bits & 16 ? ` Ack=${ack}` : ''} Len=${length}`
    const line = httpStartLine(v, payload, end)
    if (line) {
      layer('HTTP', line)
      row.protocol = 'HTTP'
      row.summary = line.value
    }
  } else {
    const len = v.getUint16(at + 4)
    if (len < 8) {
      row.note = 'UDP 长度无效'
      return
    }
    const length = Math.min(len, end - at) - 8
    layer(
      'UDP',
      ...ports,
      field('长度', len, at + 4, 2),
      field('校验和', hex16(v.getUint16(at + 6)), at + 6, 2),
      ...(length ? [field('已捕获载荷', `${length} B`, at + 8, length)] : []),
    )
    row.summary = `${source} → ${destination} UDP Len=${length}`
  }
  row.ports = [source, destination]
}

export async function readPcap(
  stream: ReadableStream<Uint8Array>,
): Promise<PcapPreview> {
  const reader = stream.getReader()
  let chunk: Uint8Array = new Uint8Array(0),
    cursor = 0,
    offset = 0,
    eof = false
  // Parse into one reusable record buffer; retain only each row's small byte preview.
  async function fill(target: Uint8Array, wanted: number) {
    let used = 0
    while (used < wanted) {
      if (cursor === chunk.length) {
        const result = await reader.read()
        if (result.done) {
          eof = true
          break
        }
        chunk = result.value
        cursor = 0
      }
      const n = Math.min(wanted - used, chunk.length - cursor)
      target.set(chunk.subarray(cursor, cursor + n), used)
      cursor += n
      used += n
      offset += n
    }
    return used
  }
  const rows: PacketRow[] = []
  function truncated(part: string): PcapPreview {
    return {
      rows,
      end: 'truncated',
      message: `文件在字节偏移 ${offset} 处截尾：${part}不完整。`,
    }
  }
  try {
    const header = new Uint8Array(24),
      h = new DataView(header.buffer)
    if ((await fill(header, 24)) < 24) return truncated('PCAP 文件头')
    const magic = h.getUint32(0)
    const little = magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1
    const nano = magic === 0x4d3cb2a1 || magic === 0xa1b23c4d
    if (!little && !nano && magic !== 0xa1b2c3d4)
      throw new Error('不是受支持的经典 PCAP 文件。')
    if (h.getUint16(4, little) !== 2 || h.getUint16(6, little) !== 4)
      throw new Error('仅支持 PCAP 2.4。')
    if (h.getUint32(20, little) !== 276)
      throw new Error('仅支持 Linux cooked v2（SLL2）链路类型。')
    const snaplen = h.getUint32(16, little)
    if (!snaplen) throw new Error('无效的 PCAP snaplen。')
    const body = new Uint8Array(Math.min(MAX_CAPTURE, snaplen))
    let first: { sec: number; fraction: number } | undefined
    const units = nano ? 1e9 : 1e6
    while (rows.length < PREVIEW_LIMIT) {
      const start = offset,
        n = await fill(header, 16)
      if (!n) return { rows, end: 'eof' }
      if (n < 16) return truncated('记录头')
      const sec = h.getUint32(0, little),
        fraction = h.getUint32(4, little)
      const captured = h.getUint32(8, little),
        original = h.getUint32(12, little)
      if (
        captured > body.length ||
        captured > original ||
        fraction >= (nano ? 1e9 : 1e6)
      ) {
        return {
          rows,
          end: 'invalid',
          message: `字节偏移 ${start} 处的记录长度或时间戳无效，已停止预览。`,
        }
      }
      if ((await fill(body, captured)) < captured)
        return truncated(`第 ${rows.length + 1} 条记录`)
      first ??= { sec, fraction }
      const time =
        new Date(sec * 1000).toISOString().slice(0, 19) +
        '.' +
        String(fraction).padStart(nano ? 9 : 6, '0') +
        'Z'
      const row: PacketRow = {
        number: rows.length + 1,
        offset: start,
        time,
        relativeTime:
          ((sec - first.sec) * units + (fraction - first.fraction)) / units,
        summary: '',
        bytes: body.slice(0, Math.min(captured, BYTE_PREVIEW)),
        layers: [],
        captured,
        original,
        protocol: '未知',
        direction: '未知',
        source: '',
        destination: '',
      }
      decodePacket(row, new DataView(body.buffer, 0, captured))
      if (!row.summary) row.summary = row.note ?? row.protocol
      rows.push(row)
    }
    return { rows, end: 'limit' }
  } finally {
    if (!eof) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
