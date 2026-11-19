/**
 * 收尾：停掉本次启动的 Server 与 Web 预览服务，删除临时业务数据、工作区和 HOME。
 * 日志留在 .run/logs 供排查；evidence/ 中的断言证据保留。
 */
import { killAll, removeWorkDirs } from './fixtures/process'

export default async function globalTeardown() {
  const stopped = await killAll()
  removeWorkDirs()
  if (stopped.length > 0) process.stdout.write(`已停止：${stopped.join('、')}\n`)
}
