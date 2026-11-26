import { describe, expect, it } from 'vitest'
import type { Task } from '@/api/types'
import {
  elapsedMinutes,
  formatDate,
  formatShortDate,
  formatTaskTime,
  formatTime,
  prioritySymbol,
  taskTimeInfo,
  todayKey,
} from './format'

const baseTask: Task = {
  id: 't1',
  title: 'Task',
  creator: 'human',
  priority: 'medium',
  artifacts: [],
  status: 'pending',
  tags: [],
  project_id: 'p1',
  created_at: '2026-03-01T09:00:00Z',
  started_at: null,
  finished_at: null,
  blocked_reason: null,
  result: null,
}

describe('formatTime', () => {
  it('formats minutes and hours', () => {
    expect(formatTime(0)).toBe('0m')
    expect(formatTime(null)).toBe('0m')
    expect(formatTime(45)).toBe('45m')
    expect(formatTime(60)).toBe('1h')
    expect(formatTime(90)).toBe('1h 30m')
    expect(formatTime(125)).toBe('2h 5m')
  })
})

describe('task formatting', () => {
  it('shows date and duration for completed tasks', () => {
    const task: Task = {
      ...baseTask,
      status: 'done',
      started_at: '2026-03-01T09:00:00Z',
      finished_at: '2026-03-01T10:30:00Z',
    }
    expect(formatTaskTime(task)).toContain('1h 30m')
  })

  it('uses elapsed time for in-progress tasks', () => {
    const now = new Date('2026-03-01T09:45:00Z').getTime()
    const task: Task = { ...baseTask, status: 'in_progress', started_at: '2026-03-01T09:00:00Z' }
    expect(formatTaskTime(task, now)).toContain('45m')
  })

  it('falls back to dashes when no timing is recorded', () => {
    expect(formatTaskTime(baseTask)).toContain('-')
    expect(formatDate(null)).toBe('-')
    expect(formatShortDate(null)).toBe('-')
    expect(elapsedMinutes(null)).toBeNull()
    expect(elapsedMinutes('2026-03-01T09:00:00Z', new Date('2026-03-01T09:30:00Z').getTime())).toBe(30)
  })

  it('summarises created, started and finished dates', () => {
    const task: Task = {
      ...baseTask,
      started_at: '2026-03-02T09:00:00Z',
      finished_at: '2026-03-03T09:00:00Z',
    }
    const info = taskTimeInfo(task)
    expect(info).toContain('Started:')
    expect(info).toContain('Finished:')
    expect(info).toContain('Created:')
  })
})

describe('symbols', () => {
  it('maps priorities to text symbols', () => {
    expect(prioritySymbol('high')).toBe('!')
    expect(prioritySymbol('medium')).toBe('-')
    expect(prioritySymbol('low')).toBe('○')
  })
})

describe('todayKey', () => {
  it('formats the local calendar day as YYYY-MM-DD', () => {
    expect(todayKey(new Date(2026, 10, 26, 23, 30).getTime())).toBe('2026-11-26')
    expect(todayKey(new Date(2026, 0, 5, 0, 1).getTime())).toBe('2026-01-05')
  })
})
