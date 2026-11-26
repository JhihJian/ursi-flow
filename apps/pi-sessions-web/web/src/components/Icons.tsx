/**
 * 按钮图标。用内联 SVG 而不是 « » ↻ 这类字形：字形在不同字体下的实际大小、
 * 基线与视觉粗细都不一样，靠 font-size 对齐不了。这里固定 12×12 的绘制盒，
 * 由 CSS 的 `--icon-size` 控制最终尺寸，所有图标因此严格同大小。
 */
import type { SVGProps } from 'react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'width' | 'height'>

function Svg({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 12 12"
      width="var(--icon-size)"
      height="var(--icon-size)"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  )
}

/** 搜索：一个圆加一根手柄。 */
export function SearchIcon() {
  return (
    <Svg>
      <circle cx="5.2" cy="5.2" r="3.3" />
      <path d="M7.7 7.7 10.2 10.2" />
    </Svg>
  )
}

/** 折叠：尖角朝左。 */
export function CollapseIcon() {
  return (
    <Svg>
      <path d="M7.4 3 4.4 6l3 3" />
    </Svg>
  )
}

/** 展开：尖角朝右。 */
export function ExpandIcon() {
  return (
    <Svg>
      <path d="M4.6 3l3 3-3 3" />
    </Svg>
  )
}

/** 重新扫描：一对循环箭头。 */
export function RefreshIcon() {
  return (
    <Svg>
      <path d="M2.6 6a3.4 3.4 0 0 1 5.7-2.5" />
      <path d="M9.4 6a3.4 3.4 0 0 1-5.7 2.5" />
      <path d="M8.4 1.7v2.1H6.3" />
      <path d="M3.6 10.3V8.2h2.1" />
    </Svg>
  )
}

/** 关闭：一个叉。 */
export function CloseIcon() {
  return (
    <Svg>
      <path d="M3 3l6 6M9 3l-6 6" />
    </Svg>
  )
}
