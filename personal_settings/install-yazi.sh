#!/bin/sh

yay -S --noconfirm --needed yazi

# check if .bashrc exists
if [ ! -f ~/.bashrc ]; then
  echo "missing bashrc file!"
  exit 1
fi

# check if yazi alias exists
if grep -Fxq "function y() {" ~/.bashrc; then
  echo "yazi bashrc function already exists"
else
  echo "setting function y() in bashrc"
  echo "" >>~/.bashrc
  echo 'function y() {
  local tmp="$(mktemp -t "yazi-cwd.XXXXXX")" cwd
  yazi "$@" --cwd-file="$tmp"
  IFS= read -r -d '\'''\'' cwd <"$tmp"
  [ -n "$cwd" ] && [ "$cwd" != "$PWD" ] && builtin cd -- "$cwd"
  rm -f -- "$tmp"
}' >>~/.bashrc
  echo "successfully added yazi alias"
fi
# check if ctrl-y keybind for yazi exists
if grep -Fxq 'bind '\''"\C-y":"\C-ay\C-m"'\''' ~/.bashrc; then
  echo "ctrl-y keybind for yazi already exists"
else
  echo "setting yazi ctrl-y keybind"
  echo "" >>~/.bashrc
  echo 'bind '\''"\C-y":"\C-ay\C-m"'\''' >>~/.bashrc
  echo "successfully added yazi ctrl-y keybind"
fi
# check if super-y keybind for yazi exists
# check if hypr/bindings.conf exists
if [ ! -f ~/.config/hypr/bindings.conf ]; then
  echo "missing ~/.config/hypr/bindings.conf file!"
  exit 1
fi
if grep -Fxq "bindd = SUPER, Y, Yazi, exec, omarchy-launch-tui yazi" ~/.config/hypr/bindings.conf; then
  echo "super-y keybind for yazi already exists"
else
  echo "setting yazi super-y keybind"
  echo "" >>~/.config/hypr/bindings.conf
  echo "bindd = SUPER, Y, Yazi, exec, omarchy-launch-tui yazi" >>~/.config/hypr/bindings.conf
  hyprctl reload
  echo "successfully added yazi super-y keybind"
fi
