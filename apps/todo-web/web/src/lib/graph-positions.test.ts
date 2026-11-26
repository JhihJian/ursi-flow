import { beforeEach, describe, expect, it } from 'vitest'
import { readPositions, writePositions } from './graph-positions'

beforeEach(() => {
  localStorage.clear()
})

describe('graph positions', () => {
  it('keeps positions per project', () => {
    writePositions('p1', { a: { x: 10, y: 20 } })
    writePositions('p2', { b: { x: 30, y: 40 } })

    expect(readPositions('p1')).toEqual({ a: { x: 10, y: 20 } })
    expect(readPositions('p2')).toEqual({ b: { x: 30, y: 40 } })
    expect(readPositions('p3')).toEqual({})
  })

  it('clears a project when writing an empty map', () => {
    writePositions('p1', { a: { x: 10, y: 20 } })
    writePositions('p1', {})
    expect(readPositions('p1')).toEqual({})
  })

  it('ignores broken values instead of failing', () => {
    localStorage.setItem('todo-web.graph-positions', 'not json')
    expect(readPositions('p1')).toEqual({})

    localStorage.setItem(
      'todo-web.graph-positions',
      JSON.stringify({ p1: { a: { x: 'x', y: 1 }, b: { x: 2, y: 3 } } }),
    )
    expect(readPositions('p1')).toEqual({ b: { x: 2, y: 3 } })
  })
})
