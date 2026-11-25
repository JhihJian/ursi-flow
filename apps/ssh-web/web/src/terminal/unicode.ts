import type { IUnicodeHandling, IUnicodeVersionProvider, Terminal } from '@xterm/xterm'

/**
 * xterm 内置的宽度表是 Unicode 6，中文、emoji、ZWJ 序列会量错宽度，
 * 表现为换行错位和重绘残影。orca 用 Unicode 11 打底再补 ZWJ 折叠，
 * 这里照搬它的 provider 实现（见 README 的 orca 移植说明）。
 */

const ZERO_WIDTH_JOINER = 0x200d
const UNICODE11_VERSION = '11'
const ORCA_UNICODE_VERSION = 'orca-11-zwj'

interface XtermUnicodeCore {
  unicodeService?: { _providers?: Record<string, IUnicodeVersionProvider> }
}

type TerminalWithUnicodeCore = Terminal & { _core?: XtermUnicodeCore }

function extractWidth(properties: number): 0 | 1 | 2 {
  return ((properties >> 1) & 3) as 0 | 1 | 2
}

function extractCharKind(properties: number): number {
  return properties >> 3
}

function createProperties(charKind: number, width: 0 | 1 | 2, shouldJoin: boolean): number {
  return ((charKind & 0xffffff) << 3) | ((width & 3) << 1) | (shouldJoin ? 1 : 0)
}

class ZeroWidthJoinerUnicodeProvider implements IUnicodeVersionProvider {
  public readonly version = ORCA_UNICODE_VERSION

  public constructor(private readonly baseProvider: IUnicodeVersionProvider) {}

  public wcwidth(codepoint: number): 0 | 1 | 2 {
    return this.baseProvider.wcwidth(codepoint)
  }

  public charProperties(codepoint: number, preceding: number): number {
    const precedingWidth = extractWidth(preceding)
    const precedingKind = extractCharKind(preceding)

    if (codepoint === ZERO_WIDTH_JOINER && precedingWidth > 0) {
      return createProperties(ZERO_WIDTH_JOINER, precedingWidth, true)
    }

    if (precedingKind === ZERO_WIDTH_JOINER && precedingWidth > 0 && this.wcwidth(codepoint) > 0) {
      // CLI 把 ZWJ emoji 算作一个宽字符；Unicode11 会为两半各进一格，导致整行右移。
      return createProperties(codepoint, precedingWidth, true)
    }

    return this.baseProvider.charProperties(codepoint, preceding)
  }
}

/** 激活 Unicode 宽度 provider，必须在任何 write/restore 之前调用。 */
export function activateTerminalUnicode(terminal: TerminalWithUnicodeCore): void {
  const unicode: IUnicodeHandling = terminal.unicode
  if (unicode.activeVersion === ORCA_UNICODE_VERSION) return

  const baseProvider = terminal._core?.unicodeService?._providers?.[UNICODE11_VERSION]
  if (!baseProvider) {
    unicode.activeVersion = UNICODE11_VERSION
    return
  }
  if (!unicode.versions.includes(ORCA_UNICODE_VERSION)) {
    unicode.register(new ZeroWidthJoinerUnicodeProvider(baseProvider))
  }
  unicode.activeVersion = ORCA_UNICODE_VERSION
}
