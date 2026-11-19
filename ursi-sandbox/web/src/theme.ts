// 同源交付时沿用 Workbench 保存的偏好；独立站点默认使用亮色品牌主题。
export function initAppearance() {
  const sync = () => {
    try {
      const root = document.documentElement
      root.dataset.theme =
        localStorage.getItem('ursi-flow:theme') === 'dark' ? 'dark' : 'light'
      root.dataset.palette =
        localStorage.getItem('ursi-flow:palette') === 'mono' ? 'mono' : 'color'
      root.classList.toggle('dark', root.dataset.theme === 'dark')
    } catch {
      /* 存储受限时由 CSS 提供默认主题。 */
    }
  }
  sync()
  window.addEventListener('storage', sync)
}
