import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state'
import { backspaceToParagraph, markdownSchema, markdownToDoc } from './markdown-editor'

const command = backspaceToParagraph(markdownSchema)

function stateOf(markdown: string, pos: number) {
  const doc = markdownToDoc(markdown)
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) })
}

describe('backspaceToParagraph', () => {
  it('turns a heading back into a paragraph at its start', () => {
    const state = stateOf('## 标题', 1)
    let applied: Transaction | null = null
    expect(command(state, (tr) => { applied = tr })).toBe(true)
    expect(applied!.doc.firstChild!.type.name).toBe('paragraph')
    expect(applied!.doc.textContent).toBe('标题')
  })

  it('turns a code block back into a paragraph at its start', () => {
    const state = stateOf('```\ncode\n```', 1)
    let applied: Transaction | null = null
    expect(command(state, (tr) => { applied = tr })).toBe(true)
    expect(applied!.doc.firstChild!.type.name).toBe('paragraph')
  })

  it('leaves paragraphs untouched', () => {
    const state = stateOf('正文', 1)
    expect(command(state)).toBe(false)
  })

  it('does nothing when the cursor is not at the block start', () => {
    const state = stateOf('## 标题', 4)
    expect(command(state)).toBe(false)
  })
})
