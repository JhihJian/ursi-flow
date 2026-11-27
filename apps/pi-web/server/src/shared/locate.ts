import { homedir } from 'node:os'
import { parse } from '@ursi/location'
import { HomeError } from './pi-home.ts'

/**
 * 把目录浏览入口收到的目标解析成本机绝对路径。
 *
 * 接受三种写法：位置 URI `file:///abs`、裸绝对路径 `/abs`、本机简写 `~`、`~/x`。
 * 只认本机。pi-web 的会话目录都在工作台所在机器上，`ssh://` 报错而不是悄悄退化。
 * 返回裸路径，因为 pi-web 的持久化与扫描都以裸路径为键。
 */
export function localPathOf(target: string, code: string): string {
  const raw = target.trim()
  if (!raw) throw new HomeError('path 缺失', 400, code)
  try {
    const loc = parse(raw, { home: homedir() })
    if (loc.scheme !== 'file') {
      throw new HomeError('pi-web 只能浏览本机目录，不支持 ssh://', 400, code)
    }
    return loc.path
  } catch (error) {
    if (error instanceof HomeError) throw error
    throw new HomeError(`path 必须是绝对路径或 file:// URI：${raw}`, 400, code)
  }
}

/** 裸路径转回位置 URI，给目录浏览响应用。 */
export function uriOf(path: string): string {
  return parse(path).uri
}
