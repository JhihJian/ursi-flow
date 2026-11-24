import { describe, expect, it } from 'vitest'
import { parseWorkspaceTarget, resolveWorkspaceUrl } from './workspace-target'

describe('parseWorkspaceTarget', () => {
  it('accepts http(s) and same-origin paths', () => {
    expect(parseWorkspaceTarget({ urlTemplate: ' https://host/live/?s={sessionId} ', label: 'Runs' })).toEqual({
      urlTemplate: 'https://host/live/?s={sessionId}',
      label: 'Runs',
    })
    expect(parseWorkspaceTarget({ urlTemplate: '/runs/{id}' })).toEqual({
      urlTemplate: '/runs/{id}',
      label: 'Workspace',
    })
  })

  it('rejects other schemes and malformed input', () => {
    expect(parseWorkspaceTarget({ urlTemplate: 'javascript:alert(1)' })).toBeNull()
    expect(parseWorkspaceTarget({ urlTemplate: '' })).toBeNull()
    expect(parseWorkspaceTarget({ urlTemplate: 42 })).toBeNull()
    expect(parseWorkspaceTarget(null)).toBeNull()
  })
})

describe('resolveWorkspaceUrl', () => {
  it('fills and encodes placeholders', () => {
    expect(
      resolveWorkspaceUrl('https://host/runs/{id}?ws={workspace}&s={sessionId}&p={project}', {
        id: 'task-1',
        project: 'Demo Project',
        workspace: 'wb/alpha',
        sessionId: 'sess 42',
      }),
    ).toBe('https://host/runs/task-1?ws=wb%2Falpha&s=sess%2042&p=Demo%20Project')
  })

  it('keeps unknown placeholders and fills empty options with blanks', () => {
    expect(
      resolveWorkspaceUrl('/runs/{id}?s={sessionId}&x={unknown}', {
        id: 't1',
        project: null,
        workspace: null,
        sessionId: null,
      }),
    ).toBe('/runs/t1?s=&x={unknown}')
  })
})
