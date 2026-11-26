import { todayKey } from '@/lib/format'
import { cx, errorMessage } from '@/lib/ui'
import { useTodoStore } from '@/store/todo-store'

/**
 * 最近七天的任务分布条：每天一根，宽度按当天任务数占比分配，可多选。
 * 「全部」清空筛选，「今天」只看今天。结构与 pi-sessions 的按日筛选一致。
 */
export function DayFilter() {
  const dayCounts = useTodoStore((state) => state.dayCounts)
  const dayFilter = useTodoStore((state) => state.dayFilter)
  const setDayFilter = useTodoStore((state) => state.setDayFilter)
  const toggleDayFilter = useTodoStore((state) => state.toggleDayFilter)

  if (dayCounts.length === 0) return null

  const apply = (dates: string[]) => {
    void setDayFilter(dates).catch((error) => alert(errorMessage(error)))
  }
  const first = dayCounts[0].date.slice(5)
  const last = dayCounts[dayCounts.length - 1].date.slice(5)

  return (
    <div className="day-filter">
      <div className="day-filter-head">
        <span className="day-filter-label">按日筛选</span>
        <span className="day-filter-span">
          {first} — {last}
        </span>
        <button
          type="button"
          className={cx('day-filter-clear', dayFilter.length === 0 && 'is-active')}
          title="不按日期筛选，显示全部任务"
          onClick={() => apply([])}
        >
          全部
        </button>
        <button
          type="button"
          className="day-filter-clear"
          title="只看今天创建的任务"
          onClick={() => apply([todayKey()])}
        >
          今天
        </button>
      </div>
      <div className="day-bars" role="group" aria-label="按任务创建日期筛选">
        {dayCounts.map(({ date, count }) => {
          const active = dayFilter.includes(date)
          return (
            <button
              key={date}
              type="button"
              className={cx('day-bar', active && 'is-active')}
              // 宽度按当天任务数占全部的比例分配，最少留 3px 以便点中。
              style={{ flexGrow: count }}
              title={`${date} · ${count} ${count === 1 ? 'task' : 'tasks'}${active ? '（已选中）' : ''}`}
              aria-pressed={active}
              onClick={() => {
                void toggleDayFilter(date).catch((error) => alert(errorMessage(error)))
              }}
            />
          )
        })}
      </div>
    </div>
  )
}
