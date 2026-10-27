# tmux integration

Snippets for `~/.tmux.conf`. Both assume `signalbox` is on the tmux
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

## Session list: waiting marker

When an agent needs you, signalbox sets the session option
`@claude_notify_session` on the agent's session rather than renaming it, so
`new-session -A -s <name>` still finds the session. To show a 🔔 beside those
sessions in the session list (prefix + s), add it to the `choose-tree` format.
This is the tmux 3.6 default format with the marker added:

```tmux
bind-key s choose-tree -Zs -F '#{?pane_format,#{?pane_marked,#[reverse],}#{pane_current_command}#{?pane_active,*,}#{?pane_marked,M,}#{?#{&&:#{pane_title},#{!=:#{pane_title},#{host_short}}},: "#{pane_title}",},#{?window_format,#{?window_marked_flag,#[reverse],}#{window_name}#{window_flags}#{?#{&&:#{==:#{window_panes},1},#{&&:#{pane_title},#{!=:#{pane_title},#{host_short}}}},: "#{pane_title}",},#{?@claude_notify_session,🔔 ,}#{session_windows} windows#{?session_grouped, (group #{session_group}: #{session_group_list}),}#{?session_attached, (attached),}}}'
```
