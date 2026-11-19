// 结果边走线：把布局给出的折点接到端口，去掉落在卡片内部的折点并生成圆角路径。
// 编辑画布与运行流转图共用同一套几何，避免两处维护后走线不一致。
import type { EdgeProps } from '@xyflow/react'
import { pointAtDistance, roundedPath, type Point } from './layout'

export function edgeGeometry(props: EdgeProps, route: Point[]) {
  const middle = [...route]
  while (middle.length && middle[0].x < props.sourceX - 1) middle.shift()
  while (middle.length && middle[middle.length - 1].x > props.targetX + 1) middle.pop()
  const points: Point[] = [
    { x: props.sourceX, y: props.sourceY },
    ...middle,
    { x: props.targetX, y: props.targetY },
  ]
  // 去掉重复折点，圆角才会正常生成。
  const clean = points.filter(
    (point, index) =>
      index === 0 || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > 1,
  )
  // 结果名贴近出口摆放，读起来像出口的标签，也不会压到其他卡片。
  return { path: roundedPath(clean, 12), label: pointAtDistance(clean, 34) }
}
