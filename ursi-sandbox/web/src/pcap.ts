export const PREVIEW_LIMIT = 500
// Observer's per-record capture limit. Never allocate based on an untrusted length.
const MAX_CAPTURE = 262144

export interface PacketRow {
  number: number
  offset: number
  time: string
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

function decodePacket(row: PacketRow, v: DataView) {
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
  for (let tags = 0; ether === 0x8100 || ether === 0x88a8; tags++) {
    row.protocol = 'VLAN'
    if (tags === 2 || size < at + 4) {
      row.note = 'VLAN 首部过深或不完整'
      return
    }
    ether = v.getUint16(at + 2)
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
    if (v.getUint16(at + 6) & 0x3fff) {
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
    end = Math.min(at + 40 + v.getUint16(at + 4), size)
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
      next = v.getUint8(at)
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
  if (next === 6) {
    const len = (v.getUint8(at + 12) >>> 4) * 4
    if (len < 20 || at + len > end) {
      row.note = 'TCP 首部长度无效或不完整'
      return
    }
  } else if (v.getUint16(at + 4) < 8) {
    row.note = 'UDP 长度无效'
    return
  }
  row.ports = [v.getUint16(at), v.getUint16(at + 2)]
}

export async function readPcap(
  stream: ReadableStream<Uint8Array>,
): Promise<PcapPreview> {
  const reader = stream.getReader()
  let chunk: Uint8Array = new Uint8Array(0),
    cursor = 0,
    offset = 0,
    eof = false
  // Only the current network chunk and one reusable record buffer are retained.
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
      const time =
        new Date(sec * 1000).toISOString().slice(0, 19) +
        '.' +
        String(fraction).padStart(nano ? 9 : 6, '0') +
        'Z'
      const row: PacketRow = {
        number: rows.length + 1,
        offset: start,
        time,
        captured,
        original,
        protocol: '未知',
        direction: '未知',
        source: '',
        destination: '',
      }
      decodePacket(row, new DataView(body.buffer, 0, captured))
      rows.push(row)
    }
    return { rows, end: 'limit' }
  } finally {
    if (!eof) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
