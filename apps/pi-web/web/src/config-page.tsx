import { useManagerNav, ManagerWorkspace } from './views/config/module'
import { SectionList } from './views/config/components/Nav'
import { usePiNav } from './pi-nav'

/** 配置页：左侧六个分区，右侧分区内容。home 清单在侧栏顶部，这里不再重复。 */
export function ConfigPage() {
  const { section, setSection } = useManagerNav()
  const { exitConfig } = usePiNav()

  return (
    <div className="pi-config-page pi-manager-root">
      <aside className="pi-config-nav">
        <SectionList active={section} onSelect={setSection} />
        <button type="button" className="pichat-button is-sm pi-config-back" onClick={exitConfig}>
          ← 返回
        </button>
      </aside>
      <ManagerWorkspace />
    </div>
  )
}
