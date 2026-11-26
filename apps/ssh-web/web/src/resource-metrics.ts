import type { HostMetrics } from './api/types'

const KIB_PER_GB = 1024 * 1024

/** 已用内存比例（%），已用 = MemTotal - MemAvailable。 */
export function memoryPercent(sample: HostMetrics): number | null {
  if (sample.mem_total_kb <= 0) return null
  return ((sample.mem_total_kb - sample.mem_available_kb) / sample.mem_total_kb) * 100
}

/**
 * 内存构成：已用 / 缓存 / 空闲。
 * 可回收缓存 = MemAvailable - MemFree，三块相加正好是 MemTotal，画构成条时不会越界。
 */
export function memoryBreakdown(sample: HostMetrics): {
  usedKb: number
  cacheKb: number
  freeKb: number
  usedPercent: number
  cachePercent: number
  freePercent: number
} | null {
  if (sample.mem_total_kb <= 0) return null
  const total = sample.mem_total_kb
  const freeKb = Math.min(Math.max(sample.mem_free_kb, 0), total)
  const usedKb = Math.min(Math.max(total - sample.mem_available_kb, 0), total)
  const cacheKb = Math.max(total - usedKb - freeKb, 0)
  const pct = (value: number): number => (value / total) * 100
  return {
    usedKb,
    cacheKb,
    freeKb,
    usedPercent: pct(usedKb),
    cachePercent: pct(cacheKb),
    freePercent: pct(freeKb),
  }
}

/** 根分区使用率（%）；df 不可用时为 null。 */
export function diskPercent(sample: HostMetrics): number | null {
  if (!sample.disk || sample.disk.total_kb <= 0) return null
  return (sample.disk.used_kb / sample.disk.total_kb) * 100
}

/** 百分比统一整数展示；空值用长横线占位，不显示 0%。 */
export function percentText(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}%`
}

/** 已用 / 总量，单位 GB。 */
export function memoryText(sample: HostMetrics): string {
  const total = sample.mem_total_kb / KIB_PER_GB
  const used = (sample.mem_total_kb - sample.mem_available_kb) / KIB_PER_GB
  return `${used.toFixed(1)} / ${total.toFixed(1)} GB`
}

/** KB 自适应单位：进程 RSS 多用 MB，内存与磁盘多用 GB。 */
export function formatKb(kb: number): string {
  if (kb >= KIB_PER_GB) return `${(kb / KIB_PER_GB).toFixed(1)} GB`
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`
  return `${Math.round(kb)} KB`
}

/** 速率自适应单位，输入为字节/秒。 */
export function formatRate(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null) return '—'
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`
  return `${Math.round(bytesPerSecond)} B/s`
}

/** 运行时长：只保留两级单位，够看就行。 */
export function formatUptime(seconds: number | null): string {
  if (seconds === null || seconds < 0) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  return `${Math.max(minutes, 1)} 分`
}

/** 延迟：10ms 以下保留一位小数，避免局域网显示成 0ms。 */
export function latencyText(value: number | null): string {
  if (value === null) return '—'
  return value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`
}

/** 采样时间按本地时分秒展示。 */
export function sampledAtText(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}
