#!/bin/sh

yay -S --noconfirm --needed xorg-xrdb
yay -S --noconfirm --needed xterm

# if [ -f ~/.config/xterm/ ]; then
#   echo "xterm configs exists.Do you want to overwrite?"
#   sudo rm -r ~/.config/.gitignore
# else
#   echo ".gitignore does not exist. Pulling from repo"
#   mv omarchy_configs/.gitignore ~/.config/.gitignore
# fi

TARGET_DIR="$HOME/.config/xterm"
if [ ! -d "omarchy_configs/xterm" ]; then
  echo "omarchy_confis does not exist. Temp clone the repo"
  git clone https://github.com/LandMineDevelopment/omarchy_configs
fi

if [ -d "$TARGET_DIR" ]; then
  echo "Warning: Directory '$TARGET_DIR' already exists."

  while true; do
    read -r -p "Overwrite and delete existing directory? This cannot be undone! (y/N): " answer
    answer=${answer:-N} # Default to No if user just presses Enter

    if [[ "$answer" =~ ^[Yy]$ ]]; then
      echo "Deleting existing directory..."
      rm -rf "$TARGET_DIR" && cp omarchy_configs/xterm "$TARGET_DIR"
      echo "Directory overwritten successfully."
      break
    elif [[ "$answer" =~ ^[Nn]$ ]]; then
      echo "Operation cancelled. Keeping existing directory."
      exit 0
    else
      echo "Please type 'y' for yes or 'n' for no."
    fi
  done
else
  mv omarchy_configs/xterm "$TARGET_DIR"
  echo "Directory created: $TARGET_DIR"
fi
