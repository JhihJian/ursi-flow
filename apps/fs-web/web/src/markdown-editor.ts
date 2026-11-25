import markdownit from 'markdown-it'
import { baseKeymap, toggleMark } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { InputRule, inputRules, wrappingInputRule, textblockTypeInputRule } from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import { MarkdownParser, MarkdownSerializer, MarkdownSerializerState, defaultMarkdownSerializer } from 'prosemirror-markdown'
import { Schema, type DOMOutputSpec, type MarkType, type Node as ProseNode } from 'prosemirror-model'
import { schema as basicSchema } from 'prosemirror-schema-basic'
import { addListNodes, liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list'
import { EditorState, Plugin } from 'prosemirror-state'
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view'

/**
 * 所见即所得的 Markdown 编辑器，做法对齐 prosemirror.net/examples/markdown（todo-web 同款）：
 * markdown-it 负责解析、prosemirror-markdown 负责序列化，编辑区直接显示渲染结果。
 */

/**
 * GFM 表格节点：table > table_row > (table_cell | table_header)。
 * 单元格内容为块级（同 basicSchema 限制），prosemirror-example-tables 的精简版。
 */
const tableNodesSpec = {
  table: {
    content: 'table_row+',
    tableRole: 'table',
    isolating: true,
    group: 'block',
    parseDOM: [{ tag: 'table' }],
    toDOM(): DOMOutputSpec {
      return ['table', ['tbody', 0]]
    },
  },
  table_row: {
    content: '(table_cell | table_header)*',
    tableRole: 'row',
    parseDOM: [{ tag: 'tr' }],
    toDOM(): DOMOutputSpec {
      return ['tr', 0]
    },
  },
  table_cell: {
    content: 'inline*',
    tableRole: 'cell',
    attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } },
    isolating: true,
    parseDOM: [
      { tag: 'td', getAttrs: (dom: Element) => cellAttrsOf(dom) },
      { tag: 'th', getAttrs: (dom: Element) => cellAttrsOf(dom) },
    ],
    toDOM(): DOMOutputSpec {
      return ['td', 0]
    },
  },
  table_header: {
    content: 'inline*',
    tableRole: 'header_cell',
    attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } },
    isolating: true,
    parseDOM: [{ tag: 'th', getAttrs: (dom: Element) => cellAttrsOf(dom) }],
    toDOM(): DOMOutputSpec {
      return ['th', 0]
    },
  },
}

export const markdownSchema = new Schema({
  nodes: addListNodes(
    basicSchema.spec.nodes.append(tableNodesSpec).update('doc', { content: 'block+' }),
    'paragraph block*',
    'block',
  ),
  marks: basicSchema.spec.marks,
})


function cellAttrsOf(dom: Element): Record<string, number | readonly number[] | null> {
  const width = dom.getAttribute('data-colwidth')
  return {
    colspan: Number(dom.getAttribute('colspan') || 1),
    rowspan: Number(dom.getAttribute('rowspan') || 1),
    colwidth: width && /^\d+(,\d+)*$/.test(width) ? width.split(',').map((n: string) => Number(n)) : null,
  }
}

/** markdown-it 开启 GFM table 后产生 table/thead/tbody/tr/th/td 的 open/close token：
 *  键名不带 _open 后缀（prosemirror-markdown 会自动派生），纯结构层（thead/tbody）标记忽略。 */
const tableTokenHandlers: Record<string, unknown> = {
  table: { block: 'table' },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: 'table_row' },
  th: { block: 'table_header' },
  td: { block: 'table_cell' },
}

const parser = new MarkdownParser(
  markdownSchema,
  markdownit('commonmark', { html: false, linkify: true }).enable('table'),
  {
    ...tableTokenHandlers,
    blockquote: { block: 'blockquote' },
    paragraph: { block: 'paragraph' },
    list_item: { block: 'list_item' },
    bullet_list: { block: 'bullet_list' },
    ordered_list: { block: 'ordered_list', getAttrs: (token) => ({ order: Number(token.attrGet('start')) || 1 }) },
    heading: { block: 'heading', getAttrs: (token) => ({ level: Number(token.tag.slice(1)) }) },
    code_block: { block: 'code_block', noCloseToken: true },
    fence: {
      block: 'code_block',
      getAttrs: (token) => ({ params: token.info || '' }),
      noCloseToken: true,
    },
    hr: { node: 'horizontal_rule' },
    image: {
      node: 'image',
      getAttrs: (token) => ({
        src: token.attrGet('src'),
        title: token.attrGet('title') || null,
        alt: token.children?.[0]?.content || null,
      }),
    },
    hardbreak: { node: 'hard_break' },
    em: { mark: 'em' },
    strong: { mark: 'strong' },
    link: {
      mark: 'link',
      getAttrs: (token) => ({ href: token.attrGet('href'), title: token.attrGet('title') || null }),
    },
    code_inline: { mark: 'code', noCloseToken: true },
  },
)

const serializerNodes = {
  ...defaultMarkdownSerializer.nodes,
  table(state: MarkdownSerializerState, node: ProseNode) {
      // GFM 管道表：首行为表头，第二行固定分隔行，之后每行一条记录。
      // 逐单元格用 renderInline 序列化到临时 state（保留行内标记并转义管道符），再对齐拼行。
      const rows = [...node.children] as ProseNode[]
      const cellTexts = rows.map((row) => [...row.children].map((cell) => renderCellToText(cell)))
      const widths = cellTexts.reduce((acc, cells) => {
        cells.forEach((text, index) => { acc[index] = Math.max(acc[index] ?? 3, text.length) })
        return acc
      }, [] as number[])
      const line = (cells: string[]): string => `| ${cells.map((text, index) => text.padEnd(widths[index])).join(' | ')} |`
      const [head, ...body] = cellTexts
      state.write(
        `${line(head)}\n${`| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`}\n${body.map((cells) => line(cells)).join('\n')}`,
      )
      state.closeBlock(node)
    },
  table_row() {},
  table_cell(state: MarkdownSerializerState, node: ProseNode) {
    // 兜底：仅在 cell 未被 table() 直接处理时使用。
    state.renderInline(node)
  },
  table_header(state: MarkdownSerializerState, node: ProseNode) {
    state.renderInline(node)
  },
  bullet_list(state: MarkdownSerializerState, node: ProseNode) {
      state.renderList(node, '  ', () => '- ')
    },
    ordered_list(state: MarkdownSerializerState, node: ProseNode) {
      const start = node.attrs.order || 1
      const maxWidth = String(start + node.childCount - 1).length
      const space = state.repeat(' ', maxWidth + 2)
      state.renderList(node, space, (index) => {
        const number = String(start + index)
        return state.repeat(' ', maxWidth - number.length) + number + '. '
      })
  },
}

const serializerMarks = defaultMarkdownSerializer.marks

const serializer = new MarkdownSerializer(
  // 管道符是 GFM 表格的结构字符，序列化时必须转义，否则单元格内容会破坏表格结构。
  serializerNodes,
  serializerMarks,
  { tightLists: true, escapeExtraCharacters: /\|/g } as never,
)

/** 把单元格渲染成单行 markdown 文本（含行内标记，管道符转义），用于表格对齐拼行。 */
function renderCellToText(cell: ProseNode): string {
  // MarkdownSerializerState 的构造器与 out 未在类型里导出，但运行时稳定可用，这里局部断言。
  type StateCtor = new (
    nodes: never,
    marks: never,
    options: { tightLists?: boolean; escapeExtraCharacters?: RegExp },
  ) => MarkdownSerializerState & { out: string }
  const StateCtor = MarkdownSerializerState as unknown as StateCtor
  const state = new StateCtor(serializerNodes as never, serializerMarks as never, {
    tightLists: true,
    escapeExtraCharacters: /\|/g,
  })
  state.renderInline(cell)
  return state.out.replace(/[\n|]/g, (ch: string) => (ch === '|' ? '\\|' : ' ')).trim()
}

/**
 * 行内语法快捷输入：输入 `**加粗**`、`*斜体*`、`` `代码` `` 后自动去掉标记并套用样式。
 * `marker` 是标记符长度，加粗是两个字符。
 */
function markInputRule(regexp: RegExp, markType: MarkType, marker: number): InputRule {
  return new InputRule(regexp, (state, match, start) => {
    const inner = match[1]
    if (!inner) return null
    const from = start + match[0].indexOf(inner)
    const to = from + inner.length
    const tr = state.tr
    tr.delete(to - marker, to)
    tr.delete(from, from + marker)
    tr.addMark(from, to - marker * 2, markType.create())
    tr.removeStoredMark(markType)
    return tr
  })
}

function blockInputRules(schema: Schema): InputRule[] {
  return [
    textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, (match) => ({
      level: match[1].length,
    })),
    wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
    wrappingInputRule(/^([-+*])\s$/, schema.nodes.bullet_list),
    wrappingInputRule(
      /^(\d+)\.\s$/,
      schema.nodes.ordered_list,
      (match) => ({ order: Number(match[1]) }),
      (match, node) => node.childCount + (node.attrs.order as number) === Number(match[1]),
    ),
    textblockTypeInputRule(/^```$/, schema.nodes.code_block),
    wrappingInputRule(/^(?:---|\*\*\*|___)\s$/, schema.nodes.horizontal_rule),
  ]
}

function buildPlugins(schema: Schema): Plugin[] {
  return [
    inputRules({
      rules: [
        ...blockInputRules(schema),
        // 前置允许非单词字符，中文标点后面直接写 **加粗** 也能生效。
        markInputRule(/(?:^|[^\w*])(\*\*[^*]+\*\*)$/, schema.marks.strong, 2),
        markInputRule(/(?:^|[^\w*])(\*[^*]+\*)$/, schema.marks.em, 1),
        markInputRule(/(?:^|[^\w`])(`[^`]+`)$/, schema.marks.code, 1),
      ],
    }),
    keymap({
      'Mod-b': toggleMark(schema.marks.strong),
      'Mod-i': toggleMark(schema.marks.em),
      'Mod-`': toggleMark(schema.marks.code),
      Enter: splitListItem(schema.nodes.list_item),
      Tab: sinkListItem(schema.nodes.list_item),
      'Shift-Tab': liftListItem(schema.nodes.list_item),
    }),
    keymap({ 'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo }),
    history(),
    keymap(baseKeymap),
  ]
}

export function createEditorView(
  host: HTMLElement,
  options: { value: string; onChange: (markdown: string) => void },
): EditorView {
  const view = new EditorView(host, {
    state: EditorState.create({
      doc: parser.parse(options.value),
      plugins: buildPlugins(markdownSchema),
    }),
    dispatchTransaction(transaction) {
      const next = view.state.apply(transaction)
      view.updateState(next)
      if (transaction.docChanged) options.onChange(serializer.serialize(next.doc))
    },
  })
  return view
}
