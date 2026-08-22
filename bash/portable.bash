# Personal interactive shell additions. Omarchy's default ~/.bashrc sources
# this file through the line installed by bootstrap.sh.

function y() {
  local tmp cwd
  tmp="$(mktemp -t 'yazi-cwd.XXXXXX')"
  yazi "$@" --cwd-file="$tmp"
  IFS= read -r -d '' cwd <"$tmp"
  [[ -n "$cwd" && "$cwd" != "$PWD" ]] && builtin cd -- "$cwd"
  rm -f -- "$tmp"
  clear
}

bind '"\C-y":"\C-ay\C-m"'

alias lg='lazygit'
bind -x '"\C-l":"lazygit"'

if [[ -f "$HOME/.tagging_bash/completion.bash" ]]; then
  source "$HOME/.tagging_bash/completion.bash"
fi

export PATH="$PATH:$HOME/.tagging_bash/bin"
