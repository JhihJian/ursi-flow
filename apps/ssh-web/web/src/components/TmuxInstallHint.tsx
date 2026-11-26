/**
 * 远端 tmux 缺失时的安装指引。
 * 树状侧栏只有 200px，按发行版给最短的一条命令，命令本身可选中复制。
 */
const TMUX_INSTALL: { platform: string; command: string }[] = [
  { platform: 'Debian/Ubuntu', command: 'sudo apt install tmux' },
  { platform: 'Fedora/RHEL', command: 'sudo dnf install tmux' },
  { platform: 'macOS', command: 'brew install tmux' },
]

export function TmuxInstallHint() {
  return (
    <div className="ssh-tmux-hint">
      <div className="ssh-tmux-hint-title">远端安装 tmux</div>
      {TMUX_INSTALL.map((item) => (
        <div className="ssh-tmux-hint-row" key={item.command}>
          <span className="ssh-tmux-hint-os">{item.platform}</span>
          <code className="ssh-tmux-hint-code">{item.command}</code>
        </div>
      ))}
    </div>
  )
}
