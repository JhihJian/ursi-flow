import { useId } from 'react'
import { Button } from '@/shared/ui/button'
import type { ConfigPackageChoice } from '@/modules/patches/api'
import {
  configStatus,
  configStatusLabels,
  type ConfigField,
  type ConfigSchema,
  type ConfigStatus,
  type ConfigValues,
  type SecretConfigured,
  type SecretValues,
  validateConfig,
} from './config'

export type ConfigFieldsProps = {
  schema: ConfigSchema
  values: ConfigValues
  secrets?: SecretValues
  secretConfigured?: SecretConfigured
  onValueChange: (key: string, value: ConfigValues[string] | undefined) => void
  onSecretChange?: (key: string, value: string) => void
  packageChoices?: ConfigPackageChoice[]
  packageLoading?: boolean
  packageError?: string
  onReloadPackages?: () => void
}

const statusStyles: Record<ConfigStatus, string> = {
  unconfigured: 'text-txt3',
  incomplete: 'text-warn',
  configured: 'text-ok',
}

function FieldLabel({ field, id }: { field: ConfigField; id: string }) {
  return <div className="flex items-baseline justify-between gap-3"><label className="field-label" htmlFor={id}>{field.label}{field.required ? ' *' : ''}</label>
    {field.type === 'secret' && <span className="text-xs text-txt3">不会回显</span>}</div>
}

function ConfigFieldControl({ field, values, secrets, secretConfigured, packageChoices, onValueChange, onSecretChange }: Pick<ConfigFieldsProps, 'values' | 'secrets' | 'secretConfigured' | 'packageChoices' | 'onValueChange' | 'onSecretChange'> & { field: ConfigField }) {
  const id = useId()
  const value = values[field.key]
  const describedBy = field.description ? `${field.key}-description` : undefined
  if (field.type === 'boolean') return <div className="flex items-center gap-2"><input id={id} type="checkbox" checked={value === true} onChange={(event) => onValueChange(field.key, event.target.checked)} />
    <FieldLabel field={field} id={id} /></div>
  if (field.type === 'enum') return <><FieldLabel field={field} id={id} /><select id={id} className="select" value={typeof value === 'string' ? value : ''} onChange={(event) => onValueChange(field.key, event.target.value || undefined)} aria-describedby={describedBy}>
    <option value="">请选择</option>{(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select></>
  if (field.type === 'configPackage') return <><FieldLabel field={field} id={id} /><select id={id} className="select" value={typeof value === 'string' ? value : ''} onChange={(event) => onValueChange(field.key, event.target.value || undefined)} aria-describedby={describedBy}>
    <option value="">{packageChoices?.length ? '请选择配置包' : '暂无可用配置包'}</option>{packageChoices?.map((choice) => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
  </select></>
  if (field.type === 'secret') return <><FieldLabel field={field} id={id} /><input id={id} className="input" type="password" autoComplete="new-password" value={secrets?.[field.key] ?? ''} placeholder={secretConfigured?.[field.key] ? '已配置，重新填写以替换' : undefined} onChange={(event) => onSecretChange?.(field.key, event.target.value)} aria-describedby={describedBy} /></>
  const type = field.type === 'integer' || field.type === 'number' ? 'number' : 'text'
  return <><FieldLabel field={field} id={id} /><input id={id} className="input" type={type} inputMode={type === 'number' ? 'decimal' : undefined} step={field.type === 'integer' ? 1 : field.type === 'number' ? 'any' : undefined} min={field.min} max={field.max} value={value === undefined ? '' : String(value)} onChange={(event) => {
    const raw = event.target.value
    if (!raw) return onValueChange(field.key, undefined)
    if (field.type === 'integer') return onValueChange(field.key, Number.isInteger(Number(raw)) ? Number(raw) : raw)
    if (field.type === 'number') return onValueChange(field.key, Number(raw))
    onValueChange(field.key, raw)
  }} aria-describedby={describedBy} /></>
}

function Field({ field, ...props }: { field: ConfigField } & Omit<ConfigFieldsProps, 'schema'>) {
  return <div className="field">
    <ConfigFieldControl field={field} {...props} />
    {field.description && <p id={`${field.key}-description`} className="text-sm leading-6 text-txt3">{field.description}</p>}
  </div>
}

export function ConfigFields({ schema, values, secrets = {}, secretConfigured = {}, onValueChange, onSecretChange, packageChoices, packageLoading = false, packageError = '', onReloadPackages }: ConfigFieldsProps) {
  const packageIds = packageChoices?.map((choice) => choice.id) ?? []
  const status = configStatus(schema, values, secrets, secretConfigured, packageIds)
  const errors = validateConfig(schema, values, secrets, secretConfigured, packageIds)
  const choices = packageChoices ?? []
  const loading = packageLoading
  const error = packageError
  const reload = onReloadPackages
  if (!schema.fields.length) return null
  return <section className="space-y-4 border-y border-line py-4" aria-labelledby="executor-config-heading">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id="executor-config-heading" className="font-semibold">执行器配置</h2><span className={`text-sm ${statusStyles[status]}`} role="status">{configStatusLabels[status]}</span></div>
    <p className="text-sm text-txt3">配置由执行器提供的 schema 决定。敏感字段只在本页内存中保留。</p>
    {error && <p role="alert" className="text-err">配置包列表读取失败：{error} {reload && <Button onClick={reload}>重试</Button>}</p>}
    {loading && schema.fields.some((field) => field.type === 'configPackage') && <p role="status" className="text-sm text-txt3">正在读取配置包…</p>}
    {errors.length > 0 && <p className="text-sm text-warn" role="alert">{errors[0]}</p>}
    <div className="space-y-4">{schema.fields.map((field) => <Field key={field.key} field={field} values={values} secrets={secrets} secretConfigured={secretConfigured} packageChoices={choices} onValueChange={onValueChange} onSecretChange={onSecretChange} packageLoading={loading} packageError={error} onReloadPackages={reload} />)}</div>
  </section>
}
