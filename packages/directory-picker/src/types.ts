/**
 * 契约类型：数据由调用方注入，包本身不发请求。
 *
 * 目录浏览接口统一为 `listDir(path) => { path, parent, entries }`：
 * 服务端负责 `~` 展开、realpath 规范化、目录校验与排序，
 * 返回的 `path` 是后续导航与提交的锚点，组件不自己拼绝对路径。
 */

/** 目录条目。`note` 是调用方的领域标注（如 pi-web 的会话数），只展示不参与行为。 */
export interface DirEntry {
  name: string
  /** 调用方附加的展示标注，如「3 个会话」。 */
  note?: string
}

/** 一次列目录的结果。`path` 为服务端规范化后的绝对路径，`parent` 在根目录为 null。 */
export interface DirListing {
  path: string
  parent: string | null
  entries: DirEntry[]
}

/** 数据注入：给定任意路径（绝对路径、`~`、`~` 开头），返回该目录的子目录清单。 */
export type ListDirFn = (path: string) => Promise<DirListing>
