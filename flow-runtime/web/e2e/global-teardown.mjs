import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
export default async function teardown() {
  try {
    const pid = Number(await readFile(join(root, '.e2e-daemon.pid'), 'utf8'))
    if (pid) process.kill(pid, 'SIGTERM')
  } catch {
    /* daemon 未启动或已退出。 */
  }
  await rm(join(root, '.e2e-daemon.pid'), { force: true })
  await rm(join(root, '.e2e-home'), { recursive: true, force: true })
  await rm(join(root, '.e2e-work'), { recursive: true, force: true })
}
