import { useEffect, useState, type RefObject } from 'react'

/** 与窄屏树/编辑分步布局的断点保持一致。 */
export const COMPACT_WIDTH = 640

/**
 * 按容器实际宽度判定窄屏布局：外层目录会压缩可用宽度，
 * 只依据视口宽度会让窄容器仍渲染双栏。容器宽度未知时回退到视口宽度。
 */
function viewportIsCompact(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof window.matchMedia === 'function') return window.matchMedia(`(max-width: ${COMPACT_WIDTH - 1}px)`).matches
  return window.innerWidth < COMPACT_WIDTH
}

export function useCompact(target: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(viewportIsCompact)

  useEffect(() => {
    const element = target.current
    const measure = () => {
      const width = element?.getBoundingClientRect().width ?? 0
      setCompact(width > 0 ? width < COMPACT_WIDTH : viewportIsCompact())
    }
    measure()
    let observer: ResizeObserver | undefined
    if (element && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(element)
    }
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [target])

  return compact
}
