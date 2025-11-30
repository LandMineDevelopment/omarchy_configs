#!/bin/sh

#IMPORTANT: run "chmod +x master-install.sh" to ensure permissions to run are set

# install programs
. ./install-yazi.sh

# add shell shortcuts

# check if .bashrc exists
if [ ! -f ~/.bashrc ]; then
    echo "missing bashrc file!"
    exit 1
fi
# check if yazi alias exists
if grep -Fxq "alias y='yazi'"; then
    echo "yazi alias already exists"
else
    echo "setting alias y='yazi'"
    echo "" >> "alias y='yazi'" 
fi

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

# reset and pull from repo
git -C ~/.config reset --hard HEAD~1
git -C ~/.config pull
rm -r omarchy_configs

# install theme
omarchy-theme-install https://github.com/LandMineDevelopment/primary-space

# install alacritty if issues with ghostty
# omarchy-install-terminal alacritty

