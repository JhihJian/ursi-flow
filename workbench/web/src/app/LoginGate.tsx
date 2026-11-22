import { useState, useSyncExternalStore } from 'react'
import { Outlet } from 'react-router'
import { readToken, sessionExpired, setToken, subscribeSession } from '@/shared/http/session'
import { Input } from '@/shared/ui/input'
import { Button } from '@/shared/ui/button'

export function LoginGate({ title = '登录工作台' }: { title?: string }) {
  const token = useSyncExternalStore(subscribeSession, readToken)
  return token ? <Outlet key={token} /> : <TokenForm title={title} />
}
function TokenForm({ title }: { title: string }) {
  const [value, setValue] = useState('')
  return <form className="panel mx-auto mt-12 w-full max-w-md space-y-5 p-6" onSubmit={event => { event.preventDefault(); setToken(value) }}>
    <h1 className="text-xl font-semibold">{title}</h1>
    <p className="text-sm text-txt3">请输入有效的服务令牌。令牌仅保存在此标签页的会话中。</p>
    {sessionExpired() && <p role="alert" className="text-sm text-err">令牌无效或已过期，请重新输入。</p>}
    <label className="field"><span className="field-label">访问令牌</span><Input type="password" autoComplete="off" value={value} onChange={event => setValue(event.target.value)} required /></label>
    <Button variant="primary" type="submit" disabled={!value.trim()}>登录</Button>
  </form>
}
