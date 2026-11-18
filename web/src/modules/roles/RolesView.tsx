import { Link } from 'react-router'

import type { McpServer, Role, Skill } from '@/shared/api/types'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'
import { Input } from '@/shared/ui/input'
import { Modal } from '@/shared/ui/modal'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { TabBar } from '@/shared/ui/tabs'
import { Textarea } from '@/shared/ui/textarea'
import { useRoleStudio, type RoleStudio } from './use-role-studio'

const ROLE_ICONS = ['robot', 'terminal', 'search', 'doc', 'sparkles', 'brain']
const ROLE_COLORS = ['#8b5cf6', '#3b82f6', '#059669', '#d97706', '#e11d48']
const COLOR_LABELS = ['紫色', '蓝色', '绿色', '琥珀色', '玫瑰色']
const EXECUTORS = ['claude-code', 'codex', 'pi']

function avatarStyle(color: string) {
  const value = /^#[0-9a-f]{6}$/i.test(color) ? color : '#8b5cf6'
  return { color: value, backgroundColor: `${value}18` }
}

function updatedLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '尚未保存'
    : `更新于 ${date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
}

function RoleAvatar({ icon, color, size }: { icon: string; color: string; size: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[10px]"
      data-identity-color
      style={{ ...avatarStyle(color), width: size, height: size, borderRadius: size > 40 ? 13 : 10 }}
    >
      {icon && icon.length <= 2 ? <span>{icon}</span> : <Icon name={icon || 'robot'} size={Math.round(size / 2)} />}
    </span>
  )
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h3 className="m-0 mb-1.5 text-sm font-semibold text-txt">{title}</h3>
      <p className="m-0 text-xs leading-[1.8] text-txt3">{description}</p>
    </div>
  )
}

/** 角色工作室：左侧角色列表，右侧四标签编辑器，未保存改动的进出与切换都先确认。 */
export default function RolesView() {
  const studio = useRoleStudio()
  const { roles, filtered, draft, dirty, busy } = studio
  const tabs = [
    { id: 'basic', label: '基本信息' },
    { id: 'prompt', label: '系统提示词' },
    { id: 'skills', label: `Skills · ${draft?.skills.length ?? 0}` },
    { id: 'mcp', label: `MCP · ${draft?.mcpServers.length ?? 0}` },
  ]

  return (
    <div className="page-stack page-stack-fill min-w-0">
      <PageHeader
        title="角色工作室"
        description="定义角色的思考方式，为流程装配专业能力。"
        actions={(
          <>
            <span className="text-xs text-txt3 max-[760px]:hidden">{roles.length} 个角色</span>
            <Button variant="primary" icon="plus" disabled={busy} onClick={() => { void studio.openCreate() }}>创建角色</Button>
          </>
        )}
      />

      <div className="panel grid min-h-[680px] min-w-0 grid-cols-1 overflow-hidden lg:min-h-0 lg:flex-1 min-[760px]:grid-cols-[215px_minmax(0,1fr)] min-[1101px]:grid-cols-[252px_minmax(0,1fr)]">
        <aside
          aria-label="角色列表"
          className="flex min-w-0 flex-col border-b border-line p-3 min-[760px]:border-b-0 min-[760px]:border-r max-[759px]:max-h-[280px] max-[759px]:overflow-y-auto lg:min-h-0 lg:overflow-y-auto"
        >
          <div className="flex items-center justify-between px-[5px] pb-3 pt-[3px] text-xs font-semibold text-txt2">
            <span>我的角色</span>
            <Button variant="ghost" size="sm" icon="plus" aria-label="创建角色" disabled={busy} onClick={() => { void studio.openCreate() }} />
          </div>
          <div className="search-input mb-3.5">
            <Icon name="search" size={15} />
            <input value={studio.search} onChange={(event) => { studio.setSearch(event.target.value) }} aria-label="搜索角色" placeholder="搜索角色…" />
          </div>

          {studio.rolesLoading || studio.rolesError ? (
            <ResourceState loading={studio.rolesLoading} error={studio.rolesError} onRetry={studio.reloadRoles} />
          ) : !roles.length ? (
            <div className="flex flex-col items-center gap-2 px-2 py-[34px] text-xs text-txt3">
              <Icon name="robot" size={25} />
              <p>还没有角色</p>
              <Button variant="outline" size="sm" onClick={() => { void studio.openCreate() }}>创建第一个角色</Button>
            </div>
          ) : !filtered.length ? (
            <div className="flex flex-col items-center gap-2 px-2 py-[34px] text-xs text-txt3">
              <p>没有匹配的角色</p>
              <Button variant="ghost" size="sm" onClick={() => { studio.setSearch('') }}>清空搜索</Button>
            </div>
          ) : (
            <div className="flex flex-col gap-[5px] max-[759px]:grid max-[759px]:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] max-[390px]:grid-cols-1">
              {filtered.map((role) => {
                const selected = studio.selectedId === role.id
                return (
                  <button
                    key={role.id}
                    type="button"
                    aria-current={selected ? 'true' : undefined}
                    disabled={busy}
                    className={`flex w-full min-w-0 items-center gap-[11px] rounded-[9px] px-2.5 py-3 text-left transition-colors disabled:opacity-65 ${selected ? 'bg-accent/10' : 'hover:bg-elevated'}`}
                    onClick={() => { void studio.selectRole(role.id) }}
                  >
                    <RoleAvatar icon={role.icon} color={role.color} size={35} />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <strong className="truncate text-xs font-medium text-txt">{role.name}</strong>
                      <span className="truncate text-[10px] text-txt3">{role.model || '未选择模型'}</span>
                    </span>
                    {selected ? <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-accent" /> : null}
                  </button>
                )
              })}
            </div>
          )}

          <div className="mt-auto flex items-center gap-[7px] px-1 pb-1 pt-[18px] text-[10px] text-txt3 max-[759px]:hidden">
            <Icon name="layers" size={14} />
            <span>配置一次，在多个流程中复用</span>
          </div>
        </aside>

        <section aria-label="角色编辑器" aria-busy={studio.detailLoading} className="flex min-h-0 min-w-0 flex-col max-[759px]:min-h-[520px]">
          {studio.detailLoading || studio.detailError ? (
            <ResourceState loading={studio.detailLoading} error={studio.detailError} onRetry={() => { void studio.loadDetail() }} />
          ) : !draft ? (
            <div className="flex flex-1 flex-col items-center justify-center px-8 py-[70px] text-center">
              <span className="mb-[22px] grid h-[76px] w-[76px] place-items-center rounded-[23px] bg-accent/10 text-accent">
                <Icon name="robot" size={34} />
              </span>
              <h2 className="m-0 mb-2.5 text-xl font-semibold text-txt">让专业能力成为角色</h2>
              <p className="m-0 mb-6 max-w-[320px] text-xs leading-[1.9] text-txt3">为角色编写提示词、配置技能与工具，再将它加入你的工作流程。</p>
              <Button icon="plus" disabled={busy} onClick={() => { void studio.openCreate() }}>创建角色</Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-[13px] border-b border-line px-4 py-4 min-[760px]:px-7 min-[760px]:py-[23px]">
                <RoleAvatar icon={draft.icon} color={draft.color} size={47} />
                <div className="min-w-0 flex-1">
                  <h2 className="m-0 text-lg font-semibold text-txt [overflow-wrap:anywhere]">{draft.name || '未命名角色'}</h2>
                  <p className="m-0 mt-1.5 text-[10px] leading-relaxed text-txt3">
                    {updatedLabel(draft.updatedAt)}
                    {dirty ? <span className="ml-2 text-warn">· 未保存</span> : null}
                  </p>
                </div>
                <div className="flex gap-[3px] max-[390px]:ml-auto">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="copy"
                    loading={studio.copying}
                    disabled={busy || dirty}
                    title={dirty ? '保存更改后再复制' : '复制角色'}
                    onClick={() => { void studio.copy() }}
                  >
                    复制
                  </Button>
                  <Button variant="ghost" size="sm" icon="trash" loading={studio.deleting} disabled={busy} onClick={() => { void studio.remove() }}>删除</Button>
                </div>
              </div>

              <TabBar tabs={tabs} value={studio.tab} onValueChange={(value) => { studio.setTab(value as typeof studio.tab) }} />

              {studio.actionError ? (
                <p role="alert" className="mx-4 mt-4 rounded-lg bg-err/10 px-3.5 py-3 text-xs text-err [overflow-wrap:anywhere] min-[760px]:mx-5">{studio.actionError}</p>
              ) : null}

              <fieldset className="m-0 min-h-0 min-w-0 flex-1 overflow-y-auto border-0 p-0" disabled={busy}>
                {studio.tab === 'basic' ? <BasicTab studio={studio} draft={draft} /> : null}
                {studio.tab === 'prompt' ? <PromptTab studio={studio} draft={draft} /> : null}
                {studio.tab === 'skills' ? <SkillsTab studio={studio} draft={draft} /> : null}
                {studio.tab === 'mcp' ? <McpTab studio={studio} draft={draft} /> : null}
              </fieldset>

              <div className="flex flex-none flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-4 min-[760px]:px-7">
                <span className={`flex items-center gap-[7px] text-[11px] ${dirty ? 'text-warn' : 'text-txt3'}`}>
                  <span className="h-[5px] w-[5px] rounded-full bg-current" />
                  {dirty ? '有未保存的更改' : '所有更改已保存'}
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {dirty ? (
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void studio.discard() }}>放弃更改</Button>
                  ) : null}
                  <Button
                    variant="primary"
                    icon="check"
                    size="sm"
                    loading={studio.saving}
                    disabled={busy || !dirty || studio.connectionsLoading || Boolean(studio.connectionsError)}
                    onClick={() => { void studio.save() }}
                  >
                    保存角色
                  </Button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      <CreateRoleModal studio={studio} />
    </div>
  )
}

const TAB_CLASS = 'flex flex-col gap-[22px] px-4 py-5 min-[760px]:p-7'
const CARD_CLASS = 'overflow-hidden rounded-[10px] border border-line'

function BasicTab({ studio, draft }: { studio: RoleStudio; draft: Role }) {
  const { connections, updateDraft, changeConnection } = studio
  const executors = [...new Set([...EXECUTORS, ...(draft.executor ? [draft.executor] : [])])]

  return (
    <div className={TAB_CLASS}>
      <SectionHeading title="角色身份" description="一个清晰的名称与职责，帮助团队找到合适的角色。" />

      <div className="flex flex-wrap gap-x-9 gap-y-5">
        <div className="field">
          <span className="field-label" id="role-icon-label">角色图标</span>
          <div className="flex flex-wrap gap-[7px]" role="group" aria-labelledby="role-icon-label">
            {ROLE_ICONS.map((icon) => (
              <button
                key={icon}
                type="button"
                className={`grid h-[34px] w-[34px] place-items-center rounded-[7px] border ${draft.icon === icon ? 'border-accent bg-accent/10 text-accent' : 'border-line text-txt3 hover:bg-elevated'}`}
                aria-label={`选择 ${icon} 图标`}
                aria-pressed={draft.icon === icon}
                onClick={() => { updateDraft({ icon }) }}
              >
                <Icon name={icon} size={17} />
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label" id="role-color-label">标识颜色</span>
          <div className="flex flex-wrap gap-[7px]" role="group" aria-labelledby="role-color-label">
            {ROLE_COLORS.map((color, index) => (
              <button
                key={color}
                type="button"
                className={`mt-1 grid h-[25px] w-[25px] place-items-center rounded-full ${draft.color === color ? 'outline outline-2 outline-offset-2 outline-current' : ''}`}
                data-identity-color
                style={avatarStyle(color)}
                aria-label={`选择${COLOR_LABELS[index]}`}
                aria-pressed={draft.color === color}
                onClick={() => { updateDraft({ color }) }}
              >
                {draft.color === color ? <Icon name="check" size={14} /> : null}
              </button>
            ))}
          </div>
        </div>
      </div>

      <label className="field">
        <span className="field-label">角色名称 <span className="text-err">*</span></span>
        <Input value={draft.name} onChange={(event) => { updateDraft({ name: event.target.value }) }} placeholder="例如：需求分析师" maxLength={100} />
      </label>

      <label className="field">
        <span className="field-label">角色描述</span>
        <Textarea value={draft.description} onChange={(event) => { updateDraft({ description: event.target.value }) }} rows={3} placeholder="描述角色的职责与适用场景…" />
      </label>

      <div className="mt-0.5 border-t border-line pt-6">
        <SectionHeading title="运行配置" description="选择执行器与模型连接，作为角色运行的默认配置。" />
      </div>

      {studio.connectionsLoading || studio.connectionsError ? (
        <ResourceState loading={studio.connectionsLoading} error={studio.connectionsError} onRetry={studio.reloadConnections} />
      ) : !connections.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[7px] bg-warn/10 px-3.5 py-3 text-[11px] leading-[1.8] text-warn">
          暂无模型连接。请先前往
          <Link to="/connections" className="underline">模型连接</Link>
          创建连接，再返回配置角色。
          <Button variant="ghost" size="sm" onClick={studio.reloadConnections}>刷新连接</Button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-[18px] min-[760px]:grid-cols-2">
        <label className="field">
          <span className="field-label">执行器 <span className="text-err">*</span></span>
          <Select value={draft.executor} onChange={(event) => { updateDraft({ executor: event.target.value }) }}>
            {executors.map((executor) => <option key={executor} value={executor}>{executor}</option>)}
          </Select>
        </label>
        <label className="field">
          <span className="field-label">模型连接 <span className="text-err">*</span></span>
          <Select
            value={draft.connectionId}
            disabled={studio.connectionsLoading || Boolean(studio.connectionsError)}
            onChange={(event) => { changeConnection(event.target.value) }}
          >
            <option value="" disabled>选择模型连接</option>
            {draft.connectionId && !connections.some((item) => item.id === draft.connectionId)
              ? <option value={draft.connectionId}>连接不可用，请重新选择</option>
              : null}
            {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name} · {connection.provider}</option>)}
          </Select>
        </label>
      </div>

      <label className="field">
        <span className="field-label">模型名称 <span className="text-err">*</span></span>
        <Input
          className="font-mono"
          value={draft.model}
          onChange={(event) => { updateDraft({ model: event.target.value }) }}
          placeholder="选择连接后填入默认模型，也可自行调整"
        />
      </label>
    </div>
  )
}

function PromptTab({ studio, draft }: { studio: RoleStudio; draft: Role }) {
  return (
    <div className={`${TAB_CLASS} min-h-[430px]`}>
      <SectionHeading title="系统提示词" description="定义角色的目标、工作方法与输出要求。支持 Markdown 格式。" />
      <div className="flex flex-1">
        <Textarea
          aria-label="系统提示词"
          className="min-h-[390px] w-full px-[18px] py-[18px] font-mono text-xs leading-[1.9] [tab-size:2]"
          spellCheck={false}
          value={draft.systemPrompt}
          onChange={(event) => { studio.updateDraft({ systemPrompt: event.target.value }) }}
          placeholder={'# 角色定位\n你是一位…\n\n# 工作方式\n1. 理解输入与目标\n2. 分析问题并给出可执行的结果\n\n# 输出要求\n清晰、准确、有依据。'}
        />
      </div>
      <div className="-mt-3 flex justify-between text-[10px] text-txt3">
        <span>Markdown</span>
        <span>{draft.systemPrompt.length.toLocaleString()} 字符</span>
      </div>
    </div>
  )
}

function SkillsTab({ studio, draft }: { studio: RoleStudio; draft: Role }) {
  return (
    <div className={TAB_CLASS}>
      <div className="flex flex-wrap items-start justify-between gap-3.5">
        <div className="min-w-0 flex-1">
          <SectionHeading title="技能库" description="将可复用的方法与操作说明，沉淀为角色的专业技能。" />
        </div>
        <Button variant="outline" size="sm" icon="plus" onClick={studio.addSkill}>添加 Skill</Button>
      </div>

      {!draft.skills.length ? (
        <div className="flex flex-col items-center rounded-[10px] border border-dashed border-line px-[18px] py-10 text-center">
          <Icon name="skills" size={30} className="text-txt3" />
          <h4 className="mb-1.5 mt-4 text-[13px] text-txt2">为角色添加一项专长</h4>
          <p className="m-0 mb-5 text-xs leading-[1.8] text-txt3">例如代码审查规范、调研方法或报告模板。</p>
          <Button variant="outline" size="sm" icon="plus" onClick={studio.addSkill}>添加第一个 Skill</Button>
        </div>
      ) : null}

      {draft.skills.map((skill: Skill, index: number) => (
        <article key={index} className={CARD_CLASS}>
          <div className="flex items-center gap-2 border-b border-line bg-elevated px-[15px] py-2 text-[11px]">
            <Icon name="skills" size={16} className="text-accent" />
            <span className="flex-1 text-txt2">Skill {String(index + 1).padStart(2, '0')}</span>
            <Button variant="ghost" size="sm" icon="trash" aria-label={`移除 Skill ${index + 1}`} onClick={() => { studio.removeSkill(index) }}>移除</Button>
          </div>
          <div className="flex flex-col gap-[18px] p-4 min-[760px]:p-5">
            <label className="field">
              <span className="field-label">技能名称</span>
              <Input value={skill.name} onChange={(event) => { studio.updateSkill(index, { name: event.target.value }) }} placeholder="例如：code-review" />
            </label>
            <label className="field">
              <span className="field-label">技能内容</span>
              <Textarea
                className="font-mono text-xs leading-[1.8]"
                rows={8}
                spellCheck={false}
                value={skill.content}
                onChange={(event) => { studio.updateSkill(index, { content: event.target.value }) }}
                placeholder="使用 Markdown 编写技能说明、操作步骤与注意事项…"
              />
            </label>
          </div>
        </article>
      ))}
    </div>
  )
}

function McpTab({ studio, draft }: { studio: RoleStudio; draft: Role }) {
  return (
    <div className={TAB_CLASS}>
      <div className="flex flex-wrap items-start justify-between gap-3.5">
        <div className="min-w-0 flex-1">
          <SectionHeading title="MCP 工具服务" description="连接外部工具与数据源，拓展角色的执行能力。" />
        </div>
        <Button variant="outline" size="sm" icon="plus" onClick={studio.addMcp}>添加 MCP</Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-[7px] bg-elevated px-3.5 py-3 text-[11px] leading-[1.8] text-txt3">
        <Icon name="lock" size={15} />
        认证信息只填写凭据引用，请勿在命令或地址中填写密钥。
      </div>

      {!draft.mcpServers.length ? (
        <div className="flex flex-col items-center rounded-[10px] border border-dashed border-line px-[18px] py-10 text-center">
          <Icon name="connector" size={30} className="text-txt3" />
          <h4 className="mb-1.5 mt-4 text-[13px] text-txt2">连接角色所需的工具</h4>
          <p className="m-0 mb-5 text-xs leading-[1.8] text-txt3">支持 HTTP 服务与 stdio 本地命令。</p>
          <Button variant="outline" size="sm" icon="plus" onClick={studio.addMcp}>添加第一个 MCP</Button>
        </div>
      ) : null}

      {draft.mcpServers.map((server: McpServer, index: number) => (
        <article key={index} className={CARD_CLASS}>
          <div className="flex items-center gap-2 border-b border-line bg-elevated px-[15px] py-2 text-[11px]">
            <Icon name="connector" size={16} className="text-accent" />
            <span className="flex-1 text-txt2">MCP {String(index + 1).padStart(2, '0')}</span>
            <Button variant="ghost" size="sm" icon="trash" aria-label={`移除 MCP ${index + 1}`} onClick={() => { studio.removeMcp(index) }}>移除</Button>
          </div>
          <div className="flex flex-col gap-[18px] p-4 min-[760px]:p-5">
            <div className="grid grid-cols-1 gap-[18px] min-[760px]:grid-cols-2">
              <label className="field">
                <span className="field-label">服务名称</span>
                <Input value={server.name} onChange={(event) => { studio.updateMcp(index, { name: event.target.value }) }} placeholder="例如：knowledge-base" />
              </label>
              <label className="field">
                <span className="field-label">传输方式</span>
                <Select
                  value={server.transport}
                  onChange={(event) => { studio.updateMcp(index, { transport: event.target.value === 'stdio' ? 'stdio' : 'http' }) }}
                >
                  <option value="http">HTTP · 远程服务</option>
                  <option value="stdio">stdio · 本地命令</option>
                </Select>
              </label>
            </div>
            {server.transport === 'http' ? (
              <label className="field">
                <span className="field-label">服务 URL</span>
                <Input className="font-mono" type="url" value={server.url ?? ''} onChange={(event) => { studio.updateMcp(index, { url: event.target.value }) }} placeholder="https://mcp.example.com/mcp" />
              </label>
            ) : (
              <label className="field">
                <span className="field-label">启动命令</span>
                <Input className="font-mono" value={server.command ?? ''} onChange={(event) => { studio.updateMcp(index, { command: event.target.value }) }} placeholder="例如：npx -y @example/mcp-server" />
              </label>
            )}
            <label className="field">
              <span className="field-label">凭据引用（可选）</span>
              <Input
                className="font-mono"
                autoComplete="off"
                value={server.credentialRef ?? ''}
                onChange={(event) => { studio.updateMcp(index, { credentialRef: event.target.value }) }}
                placeholder="例如：env:MCP_TOKEN"
              />
            </label>
          </div>
        </article>
      ))}
    </div>
  )
}

function CreateRoleModal({ studio }: { studio: RoleStudio }) {
  const { connections, createName, creating } = studio
  const blocked = !createName.trim() || studio.connectionsLoading || Boolean(studio.connectionsError) || !connections.length

  return (
    <Modal
      open={studio.createOpen}
      title="创建角色"
      width={460}
      onClose={() => { void studio.closeCreate() }}
      footer={(
        <>
          <Button variant="outline" disabled={creating} onClick={() => { void studio.closeCreate() }}>取消</Button>
          <Button variant="primary" type="submit" form="role-create-form" icon="plus" loading={creating} disabled={blocked}>创建角色</Button>
        </>
      )}
    >
      <form id="role-create-form" onSubmit={(event) => { event.preventDefault(); void studio.create() }}>
        <p className="m-0 mb-[22px] text-xs leading-[1.8] text-txt3">
          从一个名称开始，随后配置提示词、技能和工具。
          {connections.length ? `默认使用「${connections[0]?.name}」连接，创建后可修改。` : '请先创建模型连接。'}
        </p>
        {studio.connectionsLoading || studio.connectionsError ? (
          <ResourceState loading={studio.connectionsLoading} error={studio.connectionsError} onRetry={studio.reloadConnections} />
        ) : !connections.length ? (
          <p className="text-xs text-warn"><Link to="/connections" className="underline">前往创建模型连接</Link></p>
        ) : null}
        {studio.createError ? (
          <p role="alert" className="m-0 mb-[18px] rounded-lg bg-err/10 px-3.5 py-3 text-xs text-err [overflow-wrap:anywhere]">{studio.createError}</p>
        ) : null}
        <label className="field">
          <span className="field-label">角色名称</span>
          <Input
            required
            maxLength={100}
            value={createName}
            disabled={creating}
            onChange={(event) => { studio.setCreateName(event.target.value) }}
            placeholder="例如：产品需求分析师"
          />
        </label>
      </form>
    </Modal>
  )
}
