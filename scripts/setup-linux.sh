#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script must be run on Linux" >&2
  exit 1
fi

install_apt() {
  sudo apt-get update
  sudo apt-get install -y \
    build-essential \
    curl \
    file \
    git \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libssl-dev \
    libwebkit2gtk-4.1-dev \
    libxdo-dev \
    patchelf \
    pkg-config \
    wget
}

install_pacman() {
  sudo pacman -Syu --noconfirm
  sudo pacman -S --needed --noconfirm \
    appmenu-gtk-module \
    base-devel \
    curl \
    file \
    git \
    libappindicator-gtk3 \
    librsvg \
    openssl \
    patchelf \
    pkgconf \
    webkit2gtk-4.1 \
    wget \
    xdotool
}

install_dnf() {
  sudo dnf check-update || true
  sudo dnf install -y \
    curl \
    file \
    gcc \
    gcc-c++ \
    git \
    libxdo-devel \
    librsvg2-devel \
    make \
    openssl-devel \
    patchelf \
    pkgconf-pkg-config \
    webkit2gtk4.1-devel \
    wget

  if ! sudo dnf install -y libappindicator-gtk3-devel; then
    if ! sudo dnf install -y libayatana-appindicator-gtk3-devel; then
      cat <<'EOF' >&2
Could not install an appindicator development package.
On RHEL/Rocky you may need to enable EPEL/CRB repositories, then rerun this script.
EOF
      exit 1
    fi
  fi
}

if command -v apt-get >/dev/null 2>&1; then
  echo "Detected apt-based Linux distro."
  install_apt
elif command -v pacman >/dev/null 2>&1; then
  echo "Detected pacman-based Linux distro."
  install_pacman
elif command -v dnf >/dev/null 2>&1; then
  echo "Detected dnf-based Linux distro."
  install_dnf
else
  cat <<'EOF' >&2
Unsupported package manager.
This script currently supports:
  - Debian/Ubuntu (apt-get)
  - Arch Linux (pacman)
  - Fedora/RHEL/Rocky Linux (dnf)
EOF
  exit 1
fi

if ! command -v rustup >/dev/null 2>&1; then
  echo "Rust not found. Installing rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi

if ! command -v node >/dev/null 2>&1; then
  cat <<'EOF'
Node.js is not installed.
Install Node.js 20+ then run:
  npm ci
  npm run tauri:build:linux
EOF
  exit 0
fi

echo "Linux build prerequisites are installed."
echo "Next steps:"
echo "  npm ci"
echo "  npm run tauri:build:linux"
