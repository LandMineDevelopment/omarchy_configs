#!/bin/sh

yay -S --noconfirm --needed lazygit

# check if .bashrc exists
if [ ! -f ~/.bashrc ]; then
  echo "missing bashrc file!"
  exit 1
fi
# check if lazygit alias exists
if grep -Fxq "alias lg='lazygit'" ~/.bashrc; then
  echo "lazygit alias already exists"
else
  echo "setting alias lg='lazygit'"
  echo "" >>~/.bashrc
  echo "alias lg='lazygit'" >>~/.bashrc
  echo "successfully added lazygit alias"
fi
# check if ctrl-l keybind for lazygit exists
if grep -Fxq "bind -x '\"\C-l\": \"lazygit\"'" ~/.bashrc; then
  echo "ctrl-l keybind for lazygit already exists"
else
  echo "setting lazygit ctrl-l keybind"
  echo "" >>~/.bashrc
  echo "bind -x '\"\C-l\": \"lazygit\"'" >>~/.bashrc
  echo "successfully added lazygit ctrl-l keybind"
fi
source ~/.bashrc
echo "successfully sourced .bashrc"
