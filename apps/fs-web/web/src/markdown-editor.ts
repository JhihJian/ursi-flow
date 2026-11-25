import markdownit from 'markdown-it'
import { baseKeymap, toggleMark } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { InputRule, inputRules, wrappingInputRule, textblockTypeInputRule } from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import { MarkdownParser, MarkdownSerializer, defaultMarkdownSerializer } from 'prosemirror-markdown'
import { Schema, type MarkType } from 'prosemirror-model'
import { schema as basicSchema } from 'prosemirror-schema-basic'
import { addListNodes, liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list'
import { EditorState, Plugin } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'

/**
 * 所见即所得的 Markdown 编辑器，做法对齐 prosemirror.net/examples/markdown（todo-web 同款）：
 * markdown-it 负责解析、prosemirror-markdown 负责序列化，编辑区直接显示渲染结果。
 */

export const markdownSchema = new Schema({
  nodes: addListNodes(basicSchema.spec.nodes, 'paragraph block*', 'block'),
  marks: basicSchema.spec.marks,
})

const parser = new MarkdownParser(
  markdownSchema,
  markdownit('commonmark', { html: false, linkify: true }),
  {
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

const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    bullet_list(state, node) {
      state.renderList(node, '  ', () => '- ')
    },
    ordered_list(state, node) {
      const start = node.attrs.order || 1
      const maxWidth = String(start + node.childCount - 1).length
      const space = state.repeat(' ', maxWidth + 2)
      state.renderList(node, space, (index) => {
        const number = String(start + index)
        return state.repeat(' ', maxWidth - number.length) + number + '. '
      })
    },
  },
  defaultMarkdownSerializer.marks,
)

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
      if (transaction.docChanged) options.onChange(serializer.serialize(next.doc, { tightLists: true }))
    },
  })
  return view
}
