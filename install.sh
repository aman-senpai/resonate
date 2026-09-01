#!/usr/bin/env bash
set -e

# ==============================================================================
# Lyrical Universal 1-Line Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/aman-senpai/lyrical/main/install.sh | bash
# ==============================================================================

REPO="aman-senpai/lyrical"
INSTALL_DIR="${LYRICAL_INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="lyrical"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${CYAN}${BOLD}"
echo "  ♫  LYRICAL - YouTube Music Terminal Player & Lyrics CLI  ♫"
echo -e "${NC}"

# 1. Detect OS and Architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64)
    ARCH="x64"
    ;;
  aarch64|arm64)
    ARCH="arm64"
    ;;
  *)
    echo -e "${RED}Error: Unsupported architecture $ARCH${NC}"
    exit 1
    ;;
esac

case "$OS" in
  linux)
    TARGET="linux-$ARCH"
    ;;
  darwin)
    TARGET="darwin-$ARCH"
    ;;
  *)
    echo -e "${RED}Error: Unsupported operating system $OS${NC}"
    exit 1
    ;;
esac

echo -e "${BLUE}==>${NC} Detected platform: ${BOLD}$TARGET${NC}"

# 2. Ensure install directory exists
mkdir -p "$INSTALL_DIR"

# 3. Check for yt-dlp (required for YouTube audio streaming)
if ! command -v yt-dlp >/dev/null 2>&1; then
  echo -e "${YELLOW}==>${NC} yt-dlp not found. Installing standalone yt-dlp..."
  curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "$INSTALL_DIR/yt-dlp"
  chmod +x "$INSTALL_DIR/yt-dlp"
  echo -e "${GREEN}==>${NC} Installed yt-dlp to $INSTALL_DIR/yt-dlp"
else
  echo -e "${GREEN}==>${NC} Found yt-dlp: $(which yt-dlp)"
fi

# 4. Check for ffplay / ffmpeg
if ! command -v ffplay >/dev/null 2>&1; then
  echo -e "${YELLOW}Warning:${NC} 'ffplay' was not found in PATH."
  echo "Please install ffmpeg/ffplay for audio playback:"
  echo "  - Fedora:   sudo dnf install ffmpeg-free"
  echo "  - Ubuntu:   sudo apt install ffmpeg"
  echo "  - Arch:     sudo pacman -S ffmpeg"
  echo "  - macOS:    brew install ffmpeg"
fi

# 5. Download or build standalone binary
TARGET_BIN="$INSTALL_DIR/$BIN_NAME"

# Check if local build exists or if we should fetch from GitHub Releases
if [ -f "./bin/lyrical-standalone" ]; then
  echo -e "${BLUE}==>${NC} Installing local standalone build..."
  cp ./bin/lyrical-standalone "$TARGET_BIN"
elif command -v bun >/dev/null 2>&1 && [ -f "./src/index.ts" ]; then
  echo -e "${BLUE}==>${NC} Compiling standalone binary with Bun..."
  bun build --compile ./src/index.ts --outfile "$TARGET_BIN"
else
  echo -e "${BLUE}==>${NC} Downloading latest lyrical binary for $TARGET..."
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/lyrical-${TARGET}"
  
  if ! curl -fsSL "$DOWNLOAD_URL" -o "$TARGET_BIN" 2>/dev/null; then
    # Fallback to source install using Bun if release binary is not yet published
    echo -e "${YELLOW}==>${NC} Release binary not found online. Installing via Bun..."
    if ! command -v bun >/dev/null 2>&1; then
      echo -e "${BLUE}==>${NC} Installing Bun runtime..."
      curl -fsSL https://bun.sh/install | bash
      export PATH="$HOME/.bun/bin:$PATH"
    fi
    TMP_DIR="$(mktemp -d)"
    git clone --depth=1 "https://github.com/${REPO}.git" "$TMP_DIR"
    cd "$TMP_DIR"
    bun install
    bun build --compile ./src/index.ts --outfile "$TARGET_BIN"
    rm -rf "$TMP_DIR"
  fi
fi

chmod +x "$TARGET_BIN"

# 6. Check PATH
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo -e "${YELLOW}==>${NC} Adding $INSTALL_DIR to your PATH..."
    if [ -n "$BASH_VERSION" ]; then
      echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$HOME/.bashrc"
    fi
    if [ -n "$ZSH_VERSION" ]; then
      echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$HOME/.zshrc"
    fi
    if [ -f "$HOME/.config/fish/config.fish" ]; then
      echo "fish_add_path $INSTALL_DIR" >> "$HOME/.config/fish/config.fish"
    fi
    export PATH="$INSTALL_DIR:$PATH"
    ;;
esac

echo ""
echo -e "${GREEN}${BOLD}✔ Successfully installed Lyrical!${NC}"
echo -e "Run ${CYAN}${BOLD}lyrical${NC} to start playing music in your terminal."
echo ""
