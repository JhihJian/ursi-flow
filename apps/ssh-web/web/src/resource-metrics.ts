import type { HostMetrics } from './api/types'

const KIB_PER_GB = 1024 * 1024

/** 1 分钟负载占全部核心的比例（%）；cores 缺失时为 null。 */
export function loadPercent(sample: HostMetrics): number | null {
  if (sample.cores <= 0) return null
  return (sample.load1 / sample.cores) * 100
}

/** 已用内存比例（%），已用 = MemTotal - MemAvailable。 */
export function memoryPercent(sample: HostMetrics): number | null {
  if (sample.mem_total_kb <= 0) return null
  return ((sample.mem_total_kb - sample.mem_available_kb) / sample.mem_total_kb) * 100
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
