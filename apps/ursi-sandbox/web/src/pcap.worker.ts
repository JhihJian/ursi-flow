import { readPcap, type PcapPreview } from './pcap'

export type PreviewMessage =
  | { type: 'ready'; preview: PcapPreview }
  | { type: 'denied' }
  | { type: 'error'; message: string }

const failures: Record<number, string> = {
  404: '分段不存在',
  409: '采集尚未收尾，分段暂不可读',
  501: '网络观测未启用',
  503: '观测服务暂不可用',
}
const send = (message: PreviewMessage) => self.postMessage(message)

// One worker owns exactly one request. Terminating it also discards its fetch.
self.onmessage = async ({ data: url }: MessageEvent<string>) => {
  const controller = new AbortController()
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      mode: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    })
    if (response.status === 401 || response.status === 403) {
      send({ type: 'denied' })
      return
    }
    if (!response.ok)
      throw new Error(
        `${failures[response.status] ?? '分段读取失败'}（HTTP ${response.status}）`,
      )
    if (!response.body) throw new Error('响应没有可读取的数据流。')
    send({ type: 'ready', preview: await readPcap(response.body) })
  } catch (error) {
    send({
      type: 'error',
      message: error instanceof Error ? error.message : '分段读取失败。',
    })
  } finally {
    controller.abort()
    self.close()
  }
}
