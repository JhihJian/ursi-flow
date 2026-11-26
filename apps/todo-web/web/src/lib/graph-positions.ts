/**
 * 关系图的手动节点位置：只存顶层节点（分组整体）的左上角坐标，按项目分开存。
 * 浏览器本地保存，不写进待办库，因此不会进入 SUMM-Todo 的实体与同步。
 */

export interface GraphPoint {
  x: number
  y: number
}

export type GraphPositions = Record<string, GraphPoint>

const STORAGE_KEY = 'todo-web.graph-positions'

function readAll(): Record<string, GraphPositions> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return raw && typeof raw === 'object' ? (raw as Record<string, GraphPositions>) : {}
  } catch {
    return {}
  }
}

/** 读取某个项目的位置；坏数据、缺字段都按没有位置处理。 */
export function readPositions(projectId: string): GraphPositions {
  const entry = readAll()[projectId]
  if (!entry || typeof entry !== 'object') return {}
  const positions: GraphPositions = {}
  for (const [id, point] of Object.entries(entry)) {
    if (!point || typeof point !== 'object') continue
    const { x, y } = point as GraphPoint
    if (Number.isFinite(x) && Number.isFinite(y)) positions[id] = { x, y }
  }
  return positions
}

/** 整体覆盖某个项目的位置；空对象等于清空。 */
export function writePositions(projectId: string, positions: GraphPositions): void {
  const all = readAll()
  if (Object.keys(positions).length === 0) delete all[projectId]
  else all[projectId] = positions
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}
