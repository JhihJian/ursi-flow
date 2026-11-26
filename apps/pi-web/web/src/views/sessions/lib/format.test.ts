import { describe, expect, test } from 'vitest'
import type { SessionRow } from '../api'
import {
  DAY_BUCKET_DAYS,
  dailyBuckets,
  dayKey,
  defaultFoldedGroups,
  formatAge,
  formatBytes,
  formatWhen,
  groupSessions,
  matchesDays,
  matchesQuery,
  recentDayKeys,
  sessionMeta,
  sessionTitle,
  shortRoot,
  splitPinnedGroups,
  todayKey,
} from './format'

const row = (over: Partial<SessionRow>): SessionRow => ({
  id: '01a20000-0000-7000-8000-000000000001',
  path: '/root/proj-a/session.jsonl',
  projectDir: 'proj-a',
  projectKey: '/demo/alpha',
  projectName: 'alpha',
  cwd: '/demo/alpha',
  firstMessage: '第一条用户消息',
  messageCount: 3,
  created: Date.parse('2026-01-05T10:00:00.000Z'),
  modified: Date.parse('2026-01-05T10:05:00.000Z'),
  size: 2048,
  format: 'pi',
  detailsPending: false,
  ...over,
})

describe('sessionTitle', () => {
  test('改名优先，其次首条用户消息，最后退到 id', () => {
    expect(sessionTitle(row({ name: '改过名的会话' }))).toBe('改过名的会话')
    expect(sessionTitle(row({}))).toBe('第一条用户消息')
    expect(sessionTitle(row({ firstMessage: '   ' , name: undefined }))).toBe('01a20000-000')
  })

  test('过长的首条消息压成一行并截断', () => {
    const title = sessionTitle(row({ firstMessage: `a\n${'b'.repeat(200)}` }))
    expect(title.length).toBeLessThanOrEqual(81)
    expect(title.includes('\n')).toBe(false)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('formatBytes', () => {
  test('按 B / KB / MB 分档', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(128 * 1024)).toBe('128 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(formatBytes(Number.NaN)).toBe('—')
  })
})

describe('formatAge', () => {
  const now = Date.parse('2026-01-10T12:00:00.000Z')
  test('一分钟内算刚刚，之后按分钟、小时、天', () => {
    expect(formatAge(now - 30_000, now)).toBe('刚刚')
    expect(formatAge(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3 小时前')
    expect(formatAge(now - 2 * 86_400_000, now)).toBe('2 天前')
  })

  test('超过一周给日期，跨年带上年份', () => {
    expect(formatAge(Date.parse('2026-01-01T00:00:00.000Z'), now)).toMatch(/^01-0[12]$/)
    expect(formatAge(Date.parse('2025-06-01T00:00:00.000Z'), now)).toBe('2025-06-01')
  })
})

describe('sessionMeta', () => {
  test('明细未到时消息数显示省略号', () => {
    expect(sessionMeta(row({ messageCount: 3 }))).toBe('3 条 · 2.0 KB')
    expect(sessionMeta(row({ detailsPending: true }))).toBe('… · 2.0 KB')
  })
})

describe('matchesQuery', () => {
  const item = row({ name: '接口超时排查' })
  test('空查询全过，多词必须都命中', () => {
    expect(matchesQuery(item, '   ')).toBe(true)
    expect(matchesQuery(item, '接口 超时')).toBe(true)
    expect(matchesQuery(item, '接口 不存在')).toBe(false)
  })

  test('项目路径与 id 也参与匹配', () => {
    expect(matchesQuery(item, 'alpha')).toBe(true)
    expect(matchesQuery(item, '01a20000')).toBe(true)
  })
})

describe('groupSessions', () => {
  const older = row({ id: 'b', projectKey: '/demo/alpha', projectName: 'alpha', modified: 1000 })
  const newer = row({ id: 'c', projectKey: '/demo/alpha', projectName: 'alpha', modified: 3000 })
  const other = row({ id: 'd', projectKey: '/demo/beta', projectName: 'beta', cwd: '/demo/beta', modified: 2000 })

  test('组按最新活动倒序，组内同样倒序', () => {
    const groups = groupSessions([older, newer, other])
    expect(groups.map((group) => group.name)).toEqual(['alpha', 'beta'])
    expect(groups[0].sessions.map((session) => session.id)).toEqual(['c', 'b'])
    expect(groups[0].newest).toBe(3000)
  })

  test('命不中搜索的会话被丢掉，因此空掉的组不出现', () => {
    const groups = groupSessions([older, newer, other], 'beta')
    expect(groups).toHaveLength(1)
    expect(groups[0].name).toBe('beta')
    expect(groupSessions([older, other], '不存在')).toEqual([])
  })
})

describe('formatWhen', () => {
  test('固定成 YYYY-MM-DD HH:mm，个位补零', () => {
    const stamp = new Date(2026, 0, 5, 9, 7).getTime()
    expect(formatWhen(stamp)).toBe('2026-01-05 09:07')
    expect(formatWhen(Number.NaN)).toBe('—')
  })
})

describe('defaultFoldedGroups', () => {
  test('第一组与含选中会话的组展开，其余收起', () => {
    const groups = groupSessions([
      row({ id: 'a', projectKey: '/p1', projectName: 'p1', modified: 300 }),
      row({ id: 'b', projectKey: '/p2', projectName: 'p2', modified: 200 }),
      row({ id: 'c', projectKey: '/p3', projectName: 'p3', modified: 100 }),
    ])
    expect([...defaultFoldedGroups(groups, null)]).toEqual(['/p2', '/p3'])
    expect([...defaultFoldedGroups(groups, 'c')]).toEqual(['/p2'])
    expect([...defaultFoldedGroups(groups, 'a')]).toEqual(['/p2', '/p3'])
  })
})

describe('shortRoot', () => {
  test('保留末两段，短路径原样返回', () => {
    expect(shortRoot('/home/me/.pi/agent/sessions')).toBe('…/agent/sessions')
    expect(shortRoot('/data/dev')).toBe('/data/dev')
  })
})

describe('splitPinnedGroups', () => {
  const groups = groupSessions([
    row({ id: 'a', projectKey: '/p1', projectName: 'p1', modified: 300 }),
    row({ id: 'b', projectKey: '/p2', projectName: 'p2', modified: 200 }),
    row({ id: 'c', projectKey: '/p3', projectName: 'p3', modified: 100 }),
  ])

  test('关注段按设定的顺序，其余保持原样', () => {
    const split = splitPinnedGroups(groups, ['/p3', '/p1'])
    expect(split.pinned.map((group) => group.name)).toEqual(['p3', 'p1'])
    expect(split.rest.map((group) => group.name)).toEqual(['p2'])
  })

  test('当前根目录里不存在的键、重复的键都不产生空组', () => {
    const split = splitPinnedGroups(groups, ['/nope', '/p2', '/p2'])
    expect(split.pinned.map((group) => group.name)).toEqual(['p2'])
    expect(split.rest.map((group) => group.name)).toEqual(['p1', 'p3'])
  })

  test('没有关注时全部留在其余段', () => {
    const split = splitPinnedGroups(groups, [])
    expect(split.pinned).toEqual([])
    expect(split.rest).toHaveLength(3)
  })
})

describe('dayKey', () => {
  test('按本地日历日给出 YYYY-MM-DD，个位补零', () => {
    expect(dayKey(new Date(2026, 0, 5, 9, 7).getTime())).toBe('2026-01-05')
    // 同一天的不同时刻落在同一个键上
    expect(dayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05')
    expect(dayKey(new Date(2026, 11, 31, 0, 0).getTime())).toBe('2026-12-31')
  })
})

describe('todayKey / recentDayKeys', () => {
  const now = new Date(2026, 10, 26, 15, 30).getTime()

  test('todayKey 取本地日历日', () => {
    expect(todayKey(now)).toBe('2026-11-26')
  })

  test('recentDayKeys 给出连续七天，最旧在前、今天在最后', () => {
    expect(recentDayKeys(7, now)).toEqual([
      '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23',
      '2026-11-24', '2026-11-25', '2026-11-26',
    ])
  })

  test('跨月与跨年按日历日往前数，不按毫秒累减', () => {
    expect(recentDayKeys(3, new Date(2026, 0, 1, 9).getTime())).toEqual(['2025-12-30', '2025-12-31', '2026-01-01'])
    expect(recentDayKeys(1, now)).toEqual(['2026-11-26'])
  })
})

describe('dailyBuckets', () => {
  const now = new Date(2026, 10, 26, 15, 30).getTime()
  const at = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime()

  test('固定七格，含没有会话的日子，最旧在前', () => {
    const rows = [
      row({ id: 'a', modified: at(26, 9) }),
      row({ id: 'b', modified: at(26, 20) }),
      row({ id: 'c', modified: at(24) }),
    ]
    const buckets = dailyBuckets(rows, { now })
    expect(buckets).toHaveLength(DAY_BUCKET_DAYS)
    expect(buckets.map((bucket) => bucket.key)).toEqual(recentDayKeys(7, now))
    expect(buckets.map((bucket) => bucket.count)).toEqual([0, 0, 0, 0, 1, 0, 2])
  })

  test('七天之外的会话不计入任何格子', () => {
    const buckets = dailyBuckets([row({ id: 'old', modified: at(1) })], { now })
    expect(buckets.reduce((total, bucket) => total + bucket.count, 0)).toBe(0)
  })

  test('标签是 MM-DD，空列表也给出七格', () => {
    expect(dailyBuckets([], { now }).map((bucket) => bucket.label)).toEqual([
      '11-20', '11-21', '11-22', '11-23', '11-24', '11-25', '11-26',
    ])
  })
})

describe('matchesDays', () => {
  const item = row({ modified: new Date(2026, 0, 5, 12).getTime() })
  test('没有选中任何一天时不筛，选中时按日历日匹配', () => {
    expect(matchesDays(item, new Set())).toBe(true)
    expect(matchesDays(item, new Set(['2026-01-05']))).toBe(true)
    expect(matchesDays(item, new Set(['2026-01-06']))).toBe(false)
    expect(matchesDays(item, new Set(['2026-01-04', '2026-01-05']))).toBe(true)
  })
})
