/**
 * 验收收尾：停掉本次运行启动的全部进程，并删除临时业务数据、工作区和 Pi 配置。
 * 日志留在 .run/logs，下一次 global-setup 会整体重建 .run。
 */
import { killAll, removeWorkDirs } from './fixtures/cleanup'

export default async function globalTeardown() {
  const stopped = killAll()
  removeWorkDirs()
  if (stopped.length > 0) process.stdout.write(`已停止：${stopped.join('、')}\n`)
}
