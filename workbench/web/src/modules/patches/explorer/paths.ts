/** 包内相对路径工具：所有目录 API 调用都使用包根相对路径。 */
export function normalizePath(path: string): string {
  return path
    .split('/')
    .filter(segment => segment !== '' && segment !== '.')
    .join('/')
}

export function joinPath(...parts: Array<string | undefined | null>): string {
  return normalizePath(parts.filter((part): part is string => Boolean(part)).join('/'))
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** 判断 path 是否就是 parent 或位于其下。 */
export function isSameOrInside(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`)
}

/** 判断 path 是否在显示范围内；根为空表示整个包。 */
export function isWithin(path: string, root: string): boolean {
  return root === '' || isSameOrInside(path, root)
}

const LANGUAGES: Record<string, string> = {
  md: 'Markdown', markdown: 'Markdown', mdx: 'MDX',
  json: 'JSON', jsonc: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI', conf: 'Conf',
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JSX',
  ts: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', tsx: 'TSX',
  py: 'Python', sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell',
  css: 'CSS', scss: 'SCSS', html: 'HTML', xml: 'XML', svg: 'SVG',
  sql: 'SQL', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', rb: 'Ruby', php: 'PHP',
  c: 'C', h: 'C', cc: 'C++', cpp: 'C++', hpp: 'C++', cs: 'C#',
  txt: 'Text', log: 'Log', csv: 'CSV', lock: 'Lock', env: 'Env',
}

export function languageOf(path: string): string {
  const ext = basename(path).split('.').pop()?.toLowerCase() ?? ''
  return LANGUAGES[ext] ?? 'Text'
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}

/** 按扩展名直接判定为二进制，避免把压缩包、图片等读成文本再覆写。 */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'tiff',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar',
  'mp3', 'wav', 'ogg', 'flac', 'mp4', 'mov', 'webm', 'avi', 'mkv',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'exe', 'dll', 'so', 'dylib', 'wasm', 'class', 'jar', 'bin', 'dat', 'db', 'sqlite',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods',
])

export function isBinaryPath(path: string): boolean {
  const ext = basename(path).split('.').pop()?.toLowerCase() ?? ''
  return BINARY_EXTENSIONS.has(ext)
}

/** 超过该大小的文件不进入文本编辑器，只提供下载，避免整份读入内存。 */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024

export interface DecodedBlob {
  binary: boolean
  text: string
  size: number
}

/** Blob 读取字节：浏览器用 arrayBuffer，缺少该接口时退回 FileReader。 */
function readBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error('读取文件内容失败。'))
    reader.readAsArrayBuffer(blob)
  })
}

/**
 * 读取字节后判定能否安全当文本编辑：扩展名、空字节或非法 UTF-8 都按二进制处理。
 * 二进制内容只会下载，绝不会被编辑器回写覆盖。
 */
export async function decodeBlob(blob: Blob, path: string): Promise<DecodedBlob> {
  const size = blob.size
  if (isBinaryPath(path) || size > MAX_TEXT_BYTES) return { binary: true, text: '', size }
  const bytes = new Uint8Array(await readBytes(blob))
  if (bytes.includes(0)) return { binary: true, text: '', size }
  try {
    return { binary: false, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), size }
  } catch {
    return { binary: true, text: '', size }
  }
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
