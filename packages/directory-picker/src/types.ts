import type { Location } from '@ursi/location'

/**
 * 契约类型：数据由调用方注入，包本身不发请求。
 *
 * 目录浏览接口统一为 `listDir(target) => { location, parent, entries }`：
 * `target` 是位置 URI（`file:///abs`、`ssh://<设备名>/abs`），服务端负责解析、
 * realpath 规范化、目录校验与排序。返回的 `location` 是后续导航与提交的锚点，
 * 组件只经 `@ursi/location` 从它派生相邻位置，不自己拼字符串。
 */

/** 目录条目。`note` 是调用方的领域标注（如 pi-web 的会话数），只展示不参与行为。 */
export interface DirEntry {
  name: string
  /** 调用方附加的展示标注，如「3 个会话」。 */
  note?: string
}

/** 一次列目录的结果。`location` 是服务端规范化后的位置，`parent` 在设备根目录为 null。 */
export interface DirListing {
  location: Location
  parent: Location | null
  entries: DirEntry[]
}

/**
 * 数据注入：给定导航目标，返回该目录的子目录清单。
 * 目标是位置 URI；不含 `://` 的简写（如 `~`、`/abs`）原样透传，由服务端按本机路径解析。
 */
export type ListDirFn = (target: string) => Promise<DirListing>

/** 可切换的设备。`device` 是 ssh 设备名，本机不需要这一项（组件固定把它放在第一项）。 */
export interface DeviceOption {
  device: string
  /** 展示名；缺省显示设备名。 */
  label?: string
}
