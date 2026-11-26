import { describe, expect, it } from 'vitest'
import { STATUS_ORDER, nextStatuses, requiredInput } from './task-status'
import type { TaskStatus } from '@/api/types'

describe('task status transitions', () => {
  it('列出全部状态且没有自迁移', () => {
    expect(STATUS_ORDER).toEqual(['pending', 'in_progress', 'blocked', 'done', 'cancelled'])
    for (const status of STATUS_ORDER) {
      expect(nextStatuses(status)).not.toContain(status)
    }
  })

  it('与 todo-core 状态机保持一致', () => {
    expect(nextStatuses('pending')).toEqual(['in_progress', 'cancelled'])
    expect(nextStatuses('in_progress')).toEqual(['done', 'blocked', 'cancelled', 'pending'])
    expect(nextStatuses('blocked')).toEqual(['in_progress', 'cancelled'])
    expect(nextStatuses('done')).toEqual(['in_progress'])
    expect(nextStatuses('cancelled')).toEqual([])
  })

  it('完成任务需要结果，阻塞任务需要原因', () => {
    const withInput = STATUS_ORDER.filter((status) => requiredInput(status) !== null)
    expect(withInput).toEqual(['blocked', 'done'])
    expect(requiredInput('done')).toBe('result')
    expect(requiredInput('blocked')).toBe('blocked_reason')
    expect(requiredInput('in_progress' as TaskStatus)).toBeNull()
  })
})
