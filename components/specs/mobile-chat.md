# Set up mobile chat

The local spike lets Signalbox on iOS send text to an idle Claude Code or Codex
session running in tmux on your computer. Keep Signalbox and the computer running.
The phone and the owning computer's hub or forwarder need the mobile-chat build;
a remote hub also needs it. No native agent input API is used yet.

1. In your project directory, start tmux: `tmux new -s mobile-chat`.
2. Start `claude`, or start `codex --no-daemon`. Codex's shared daemon cannot
   reliably identify the tmux pane that owns a conversation, so this spike
   requires its standalone mode.
3. With Signalbox's agent hooks installed, send a message in the terminal and
   wait for the agent to finish. Open that session on your phone.
4. Keep the terminal's input empty, type a message on your phone and tap Send.

To continue an existing conversation, finish its task and exit the agent first.
Inside tmux, run `claude --resume <session-id>` or
`codex --no-daemon resume <session-id>`. Do not run two copies of the conversation.

**Sent to terminal** confirms that tmux accepted the paste and Enter. The agent's
normal hooks update the conversation afterward. An unconfirmed delivery keeps
your draft: check the session before sending it again. Signalbox never
automatically replays a message after reconnecting.

For this spike, wait until the agent is idle. Answer permission dialogs and
interactive questions in its terminal. Child agents use their owning session's
input. Images, files, cancellation and native Codex input are not included.

The sender checks the captured process, foreground process group and tmux pane
and active conversation binding before input. It recognizes the empty prompt
at the live cursor and refuses a terminal draft or an unfamiliar input screen.
It refuses a stopped, ambiguous or unverified target. These checks
cannot make terminal input atomic with a process exiting, and they cannot manage
a draft you are simultaneously typing in the terminal.
