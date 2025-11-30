#!/bin/sh

# install programs
. ./install-yazi.sh
. ./install-stow.sh


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
