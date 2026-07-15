# tmux integration

Two snippets for `~/.tmux.conf`. Both assume `signalbox` is on the tmux
server's `PATH` - use the absolute path to the binary if it is not.

## Status line: waiting count

`signalbox tmux status` prints a one-line summary like `🔔 2` (empty string
when nothing waits). Prepend it to the existing `status-right`:

```tmux
# Already set to 2 - #(...) segments refresh once per status-interval,
# so signals appear within 2s.
set -g status-interval 2

# Existing clock segment, with the signalbox count in front.
set -g status-right '#(command -v signalbox >/dev/null && signalbox tmux status)  #[fg=color250] %Y-%m-%d #[fg=white,bold]%H:%M:%S'

# Current value is 50; the count segment adds up to ~5 cells, so widen a touch.
set -g status-right-length 60
```

## Jump picker: prefix + j

Opens the interactive picker (fzf when installed) in a popup; Enter jumps to
the selected session's pane. The popup is sized to the picker's content -
wide enough for the detail column, short enough to sit over your work.

```tmux
bind-key j display-popup -E -w 80% -h 15 "command -v signalbox >/dev/null && signalbox pick || echo signalbox is not installed"
```
