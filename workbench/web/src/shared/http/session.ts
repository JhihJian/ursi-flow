const key = import.meta.env.URSI_EXECUTOR_CONSOLE ? 'ursi-executor:bearer' : 'ursi-flow:bearer'
const changed = 'ursi-flow:session'

export function readToken(): string {
  return sessionStorage.getItem(key) ?? ''
}
let expired = false
export function sessionExpired() { return expired }
export function setToken(value: string, unauthorized = false) {
  expired = unauthorized
  if (value.trim()) sessionStorage.setItem(key, value.trim())
  else sessionStorage.removeItem(key)
  window.dispatchEvent(new Event(changed))
}
export function subscribeSession(notify: () => void) {
  window.addEventListener(changed, notify)
  return () => window.removeEventListener(changed, notify)
}
