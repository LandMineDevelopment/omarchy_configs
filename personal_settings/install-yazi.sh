#!/bin/sh

yay -S --noconfirm --needed yazi

# check if .bashrc exists
if [ ! -f ~/.bashrc ]; then
  echo "missing bashrc file!"
  exit 1
fi
# check if yazi alias exists
if grep -Fxq "alias y='yazi'" ~/.bashrc; then
  echo "yazi alias already exists"
else
  echo "setting alias y='yazi'"
  echo "" >>~/.bashrc
  echo "alias y='yazi'" >>~/.bashrc
  echo "successfully added yazi alias"
fi
# check if ctrl-y keybind for yazi exists
if grep -Fxq "bind -x '\"\C-y\": \"yazi\"'" ~/.bashrc; then
  echo "ctrl-y keybind for yazi already exists"
else
  echo "setting yazi ctrl-y keybind"
  echo "" >>~/.bashrc
  echo "bind -x '\"\C-y\": \"yazi\"'" >>~/.bashrc
  echo "successfully added yazi ctrl-y keybind"
fi
source ~/.bashrc
echo "successfully sourced .bashrc"
