export const portalRegions = ['title', 'left-top', 'left-bottom', 'center', 'right', 'status'] as const
export type PortalRegion = typeof portalRegions[number]

export const regionLabels: Record<PortalRegion, string> = {
  title: '上标题栏',
  'left-top': '左上',
  'left-bottom': '左下',
  center: '中间',
  right: '右侧',
  status: '下方状态栏',
}
