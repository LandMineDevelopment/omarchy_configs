#!/bin/sh

#IMPORTANT: run "chmod +x master-install.sh" to ensure permissions to run are set

# pull .config files from repo and migrate to appropriate places
if [ -d "omarchy_configs" ]; then
  echo "omarchy_configs exists. Deleting before pulling"
  sudo rm -r omarchy_configs
  git clone https://github.com/LandMineDevelopment/omarchy_configs
else
  echo "omarchy_configs does not exist. Pulling from repo"
  git clone https://github.com/LandMineDevelopment/omarchy_configs
fi

if [ -d ~/.config/.git ]; then
  echo ".git exists. Deleting before pulling"
  sudo rm -r ~/.config/.git
  mv omarchy_configs/.git ~/.config/.git
else
  echo ".git does not exist. Pulling from repo"
  mv omarchy_configs/.git ~/.config/.git
fi

if [ -f ~/.config/.gitignore ]; then
  echo ".gitignore exists. Deleting before pulling"
  sudo rm -r ~/.config/.gitignore
else
  echo ".gitignore does not exist. Pulling from repo"
  mv omarchy_configs/.gitignore ~/.config/.gitignore
fi

# install programs#############
# packagemanager
. ./install-yay.sh
# file managers
. ./install-yazi.sh
. ./install-nnn.sh
# git
. ./install-lazygit.sh
# editors
# terminals
. ./install-xterm.sh

# reset and pull from repo
rm -r omarchy_configs

if [ -d "~/.config/omarchy" ]; then
  # install theme
  omarchy-theme-install https://github.com/LandMineDevelopment/primary-space

  # install alacritty if issues with ghostty
  # omarchy-install-terminal alacritty

  omarchy-update
fi
