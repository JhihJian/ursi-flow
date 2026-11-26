import re

src = open('src/styles.css').read()
# 去掉注释，保留结构
src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
ROOT = '.pi-manager-root'

def blocks(text):
    out = []
    i = 0
    buf = ''
    while i < len(text):
        c = text[i]
        if c == '{':
            depth = 1
            j = i + 1
            while j < len(text) and depth > 0:
                if text[j] == '{':
                    depth += 1
                elif text[j] == '}':
                    depth -= 1
                j += 1
            out.append((buf.strip(), text[i+1:j-1]))
            buf = ''
            i = j
        else:
            buf += c
            i += 1
    return out

SKIP = {'html', 'body', '#root', 'html, body, #root', 'html,body,#root'}

def scope_prelude(prelude):
    parts = [re.sub(r'\s+', ' ', p.strip()) for p in prelude.split(',')]
    out = []
    for part in parts:
        if not part or part in SKIP or part == ':root':
            continue
        if part == '*':
            out.append(f'{ROOT}, {ROOT} *')
            continue
        if part in ('*::before', '*::after', '*::-webkit-scrollbar'):
            out.append(f'{ROOT} {part}')
            continue
        out.append(f'{ROOT} {part}')
    return ', '.join(dict.fromkeys(out))

def render(text):
    chunks = []
    for prelude, body in blocks(text):
        flat = re.sub(r'\s+', ' ', prelude).strip()
        if flat.startswith('@media') or flat.startswith('@supports') or flat.startswith('@container'):
            chunks.append(f'{flat} {{\n{render(body)}\n}}')
            continue
        if flat.startswith('@'):
            chunks.append(f'{flat} {{ {body.strip()} }}')
            continue
        if flat == ':root':
            chunks.append(f'{ROOT} {{\n{body.strip()}\n}}')
            continue
        if flat in SKIP:
            continue
        if not flat:
            continue
        sel = scope_prelude(flat)
        if not sel:
            continue
        chunks.append(f'{sel} {{\n{body.strip()}\n}}')
    return '\n\n'.join(chunks)

header = """/*
 * 管理台模块样式（由 src/styles.css 用 scripts/scope-css.py 生成，勿手改）。
 *
 * 独立入口仍然 import styles.css；作为工作台模块时用这份作用域化版本：
 * 所有选择器都挂在 .pi-manager-root 下，:root 变量搬到根类上，
 * html/body/#root 与全局 reset 不下发，避免污染宿主外壳。
 */

.pi-manager-root,
.pi-manager-root *,
.pi-manager-root *::before,
.pi-manager-root *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

/* 出版物式版面靠隐藏滚动条维持，作用域内保持一致。 */
.pi-manager-root * {
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.pi-manager-root *::-webkit-scrollbar {
  display: none;
}

.pi-manager-root {
  height: 100%;
  overflow: hidden;
  color: var(--gray-900);
  background: var(--white);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
}

"""

body = render(src)
open('src/module.css', 'w').write(header + body + '\n')
print('ok', len(body))
