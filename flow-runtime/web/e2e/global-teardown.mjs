import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
export default async function teardown() {
  for (const name of ['.e2e-daemon.pid', '.e2e-model.pid']) {
    try {
      const pid = Number(await readFile(join(root, name), 'utf8'))
      if (pid) process.kill(pid, 'SIGTERM')
    } catch {
      /* 进程未启动或已退出。 */
    }
    await rm(join(root, name), { force: true })
  }
  await rm(join(root, '.e2e-home'), { recursive: true, force: true })
  await rm(join(root, '.e2e-work'), { recursive: true, force: true })
  await rm(join(root, '.e2e-workspaces'), { recursive: true, force: true })
}
