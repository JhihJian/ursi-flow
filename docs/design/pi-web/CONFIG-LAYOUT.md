# Pi Web 配置视图布局骨架

参考开源 pi-web 设置页（列表 + 详情 split view）的结构思想，结合本仓已有的
split 词汇表 CSS，为配置视图定下的布局契约。只取骨架职责，按钮、开关、
字段等皮肤仍用本仓 `.btn` / `.switch` / `.field`。

## 结构

每个列表型分区（模型配置、Skills、Subagent、插件、MCP）用
`components/layout.tsx` 的四个结构组件组装：

```
SectionSplit（分区根，panel-split）
├── panel-body（flex 行，不滚）
│   ├── panel-list（左列表，唯一滚动层之一）
│   │   ├── SectionListHead（标题 + 过滤框/新增按钮，sticky）
│   │   ├── SectionListItem×N（行内状态点 data-mark、标题、副行、徽标）
│   │   └── SectionListAction（底部固定「新增」）
│   └── panel-detail（右详情，唯一滚动层之二）
│       └── detail-sheet.is-plain（编辑器复用原有表单语义）
└── panel-footer（状态行，固定不滚；SectionFooterNote）
```

- `SectionListItem` 的 `data-mark`：`ok`（可用）/ `off`（停用）/ `warn`
  （需注意），行首状态点着色。
- 编辑器组件（ProviderEditor、EntryEditor、ServerEditor、ProfileEditor）
  只换外层容器为 `detail-sheet is-plain` + `SectionDetailHead`，内部表单
  与写回语义不变。
- 模型配置分区把 pi 的模型相关配置收进一个菜单：左列表 = 默认模型、
  启用模型、自建 provider×N + 新增；右侧对应默认模型表单、
  ScopedModelsPanel、ProviderEditor。常规分区是非模型项的纯表单页
  （`.section` 直接作滚动层）。

## 高度链约定（防滚动回归）

见 `module.css` 头注释：`main.config-detail`（不滚）→
`.config-section-host`（不滚）→ `.panel-list` / `.panel-detail`（唯一滚动
层）。中间任何一层丢 `min-height:0` 或 flex 约束，内容超高即被裁切且无法
滚动。新增分区必须经 `SectionSplit` 或 `.section` 接入，不得自造容器链。

## 与开源 pi-web 的取舍

- 只学布局骨架（split view、分组列表、footer 状态行），不移植其
  primitives 全家桶与模态/焦点管理/移动端单 pane 逻辑。
- 模型相关配置（默认模型/思考级别/启用模型/自建 provider）合并为「模型
  配置」一个菜单，分区 id 保留 `models` 不变；常规分区只留非模型项。
- 发现模型列表、逐个添加等交互只在本仓实现。
