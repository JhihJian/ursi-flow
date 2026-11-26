/**
 * mcp.json 条目的敏感值遮蔽（对齐 pi-web 的 mcp-secrets，取常用子集）。
 *
 * 原则：只遮蔽「字面量密钥」，`${VAR}` 引用与 `!command` 动态值原样保留；
 * 遮蔽结果必须可逆——写回时若提交值与「原文的遮蔽形式」一致就还原原文，
 * 否则视为用户输入的新值。因此 URL/命令/参数里的局部遮蔽也能安全往返。
 */

const SECRET_WORDS = new Set([
  'key', 'apikey', 'token', 'secret', 'password', 'passwd', 'passphrase', 'pwd',
  'pass', 'credential', 'credentials', 'authorization', 'bearer', 'jwt',
  'cookie', 'signature', 'pat',
])
const SECRET_SUFFIXES = ['token', 'secret', 'password', 'passwd', 'apikey']
const QUALIFIER_WORDS = new Set([
  'file', 'path', 'dir', 'url', 'uri', 'endpoint', 'id', 'name', 'type',
  'header', 'env', 'var', 'cmd', 'command', 'script', 'prompt', 'range',
])
const VAR_REF_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Z_][A-Z0-9_]*(?![A-Za-z0-9_])/
const ANY_VAR_REF = new RegExp(VAR_REF_RE.source)
const CREDENTIAL_PHRASE_RE = /^(?:bearer|basic|token)\s+\S/i
const MASK = '•••'

export function maskSecret(value: string): string {
  const tail = value.length > 8 ? value.slice(-4) : ''
  return `${MASK}${tail ? `（末4位 ${tail}）` : ''}`
}

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

export function isSecretName(name: string): boolean {
  const parts = nameWords(name)
  if (parts.length > 1 && QUALIFIER_WORDS.has(parts[parts.length - 1])) return false
  return parts.some(
    (word) => SECRET_WORDS.has(word) || SECRET_SUFFIXES.some((s) => word.length > s.length && word.endsWith(s)),
  )
}

function hasVarRef(value: string): boolean {
  return ANY_VAR_REF.test(value)
}

/** `${VAR}` 引用本身不是密钥；整值只是引用时保留原样。 */
function isReferenceOnly(value: string): boolean {
  const rest = value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Z_][A-Z0-9_]*(?![A-Za-z0-9_])/g, '')
  return hasVarRef(value) && rest.trim() === ''
}

/** 看起来像字面量令牌：常见前缀，或长且字母数字混合的高熵串。 */
export function looksLikeSecretValue(value: string): boolean {
  if (value.length < 8 || /\s/.test(value)) return false
  if (/^(?:sk-|sk_|pk-|pk_|ghp_|gho_|ghu_|ghs_|xox[abp]-|AKIA|AIza|eyJ)/.test(value)) return true
  if (CREDENTIAL_PHRASE_RE.test(value)) return true
  return value.length >= 24 && /[A-Za-z]/.test(value) && /\d/.test(value) && /^[A-Za-z0-9._~+/=-]+$/.test(value)
}

function maskUrl(value: string): string {
  try {
    const url = new URL(value)
    let changed = false
    if (url.username) {
      url.username = MASK
      changed = true
    }
    if (url.password) {
      url.password = MASK
      changed = true
    }
    for (const [name, paramValue] of [...url.searchParams.entries()]) {
      if (!paramValue || isReferenceOnly(paramValue)) continue
      if (isSecretName(name) || looksLikeSecretValue(paramValue)) {
        url.searchParams.set(name, MASK)
        changed = true
      }
    }
    if (changed) {
      // hash 参数单独重建，避免 URLSearchParams 改写 # 的其它内容。
      const hashParams = new URLSearchParams(url.hash.slice(1))
      for (const [name, paramValue] of [...hashParams.entries()]) {
        if (!paramValue || isReferenceOnly(paramValue)) continue
        if (isSecretName(name) || looksLikeSecretValue(paramValue)) hashParams.set(name, MASK)
      }
      if (url.hash) url.hash = `#${hashParams.toString()}`
      return url.toString().replace(/%E2%80%A2/g, MASK)
    }
    return value
  } catch {
    return looksLikeSecretValue(value) && !isReferenceOnly(value) ? MASK : value
  }
}

function flagTakesSecret(flag: string): boolean {
  if (!/^--?[A-Za-z]/.test(flag)) return false
  const name = flag.replace(/^-+/, '')
  return isSecretName(name) || nameWords(name).at(-1) === 'auth' || name === 'k'
}

function maskWord(word: string): string {
  if (!word || isReferenceOnly(word)) return word
  const pair = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(word)
  if (pair && pair[2] && isSecretName(pair[1]) && !isReferenceOnly(pair[2])) {
    return `${pair[1]}=${MASK}`
  }
  const header = /^([A-Za-z0-9_-]+):(\s*)([\s\S]*)$/.exec(word)
  if (header && header[3] && isSecretName(header[1]) && !isReferenceOnly(header[3])) {
    return `${header[1]}:${header[2]}${MASK}`
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(word)) return maskUrl(word)
  if (looksLikeSecretValue(word)) return MASK
  return word
}

/** 词序列：保留选项名，只替换选项值、header 值与像令牌的词。 */
function maskTokens(tokens: readonly string[]): string[] {
  let secretNext = false
  return tokens.map((token) => {
    if (secretNext && !/^-/.test(token)) {
      secretNext = false
      return isReferenceOnly(token) ? token : MASK
    }
    const flagValue = /^(--?[A-Za-z][A-Za-z0-9_.-]*)=([\s\S]*)$/.exec(token)
    if (flagValue) {
      const [, flag, value] = flagValue
      if (value && flagTakesSecret(flag) && !isReferenceOnly(value)) return `${flag}=${MASK}`
      return `${flag}=${maskWord(value)}`
    }
    if (/^--?[A-Za-z][A-Za-z0-9_.-]*$/.test(token)) {
      secretNext = flagTakesSecret(token)
      return token
    }
    if (/^(?:bearer|basic|token)$/i.test(token)) {
      secretNext = true
      return token
    }
    const header = /^([A-Za-z0-9_-]+):$/.exec(token)
    if (header && isSecretName(header[1])) {
      secretNext = true
      return token
    }
    return maskWord(token)
  })
}

/** 一条命令行：保留空白与选项名，只替换选项值与像令牌的词。 */
export function maskCommand(value: string): string {
  const parts = value.split(/(\s+)/)
  const tokens = parts.filter((_, index) => index % 2 === 0)
  const masked = maskTokens(tokens)
  return parts.map((part, index) => (index % 2 === 0 ? masked[index / 2] : part)).join('')
}

/** 参数数组：作为一整个序列遮蔽，`--token <值>` 的关联不会因逐项处理而丢失。 */
export function maskArgs(args: readonly string[]): string[] {
  return maskTokens(args)
}

export function maskArg(value: string): string {
  return maskTokens([value])[0]
}

/**
 * 一个字符串字段的遮蔽形式。`key` 是字段名（env/header 名也走这里）。
 * 不可逆的输入（引用、!command）原样返回。
 */
export function maskStringField(key: string, value: string): string {
  if (value === '' || value.startsWith('!') || isReferenceOnly(value)) return value
  // `Bearer ${TOKEN}`：凭据本身是引用，只有 scheme 是字面量，保留原样。
  if (hasVarRef(value)) {
    const withoutRefs = value
      .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Z_][A-Z0-9_]*(?![A-Za-z0-9_])/g, '')
      .trim()
      .toLowerCase()
    if (/^(?:bearer|basic|token)?[\s:]*$/.test(withoutRefs)) return value
  }
  if (key === 'url') return maskUrl(value)
  if (key === 'command') return maskCommand(value)
  if (isSecretName(key) || CREDENTIAL_PHRASE_RE.test(value)) return maskSecret(value)
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return maskUrl(value)
  if (looksLikeSecretValue(value)) return maskSecret(value)
  return value
}
