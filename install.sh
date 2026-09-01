#!/usr/bin/env bash
set -e

# ==============================================================================
# Resonate Universal Automated Installer
# Automatically installs Resonate and all dependencies (yt-dlp, ffmpeg/ffplay)
# Usage: curl -fsSL https://raw.githubusercontent.com/aman-senpai/resonate/master/install.sh | bash
# ==============================================================================

REPO="aman-senpai/resonate"
INSTALL_DIR="${RESONATE_INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="resonate"

# Colors (No Emojis)
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${CYAN}${BOLD}"
echo "============================================================"
echo "  RESONATE - Automated Terminal Player & Dependency Setup"
echo "============================================================"
echo -e "${NC}"

# 1. Detect OS and Architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64)
    ARCH="x64"
    FFMPEG_ARCH="linux64"
    ;;
  aarch64|arm64)
    ARCH="arm64"
    FFMPEG_ARCH="linuxarm64"
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

echo -e "${BLUE}[1/5]${NC} Detected platform: ${BOLD}$TARGET${NC}"

# 2. Ensure install directory exists and is in PATH for this script
mkdir -p "$INSTALL_DIR"
export PATH="$INSTALL_DIR:$PATH"

# 3. Automated yt-dlp Installation
echo -e "${BLUE}[2/5]${NC} Checking audio extraction engine (yt-dlp)..."
if command -v yt-dlp >/dev/null 2>&1; then
  echo -e "      Found existing yt-dlp at: $(which yt-dlp)"
else
  echo -e "      Downloading standalone yt-dlp binary..."
  if curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "$INSTALL_DIR/yt-dlp"; then
    chmod +x "$INSTALL_DIR/yt-dlp"
    echo -e "${GREEN}      Installed yt-dlp to $INSTALL_DIR/yt-dlp${NC}"
  else
    echo -e "${RED}      Failed to download yt-dlp. Audio streaming may be impaired.${NC}"
  fi
fi

# 4. Automated ffmpeg & ffplay Installation
echo -e "${BLUE}[3/5]${NC} Checking audio playback engine (ffmpeg / ffplay)..."
if command -v ffplay >/dev/null 2>&1; then
  echo -e "      Found existing ffplay at: $(which ffplay)"
else
  INSTALLED_FFMPEG=false

  # Try system package managers if sudo is non-interactive or available
  if [ "$OS" = "linux" ]; then
    if command -v dnf >/dev/null 2>&1 && [ "$EUID" -eq 0 ]; then
      echo -e "      Installing ffmpeg via dnf..."
      dnf install -y ffmpeg-free || dnf install -y ffmpeg || true
    elif command -v apt-get >/dev/null 2>&1 && [ "$EUID" -eq 0 ]; then
      echo -e "      Installing ffmpeg via apt-get..."
      apt-get update -qq && apt-get install -y ffmpeg || true
    elif command -v pacman >/dev/null 2>&1 && [ "$EUID" -eq 0 ]; then
      echo -e "      Installing ffmpeg via pacman..."
      pacman -Sy --noconfirm ffmpeg || true
    elif command -v apk >/dev/null 2>&1 && [ "$EUID" -eq 0 ]; then
      echo -e "      Installing ffmpeg via apk..."
      apk add ffmpeg || true
    elif command -v zypper >/dev/null 2>&1 && [ "$EUID" -eq 0 ]; then
      echo -e "      Installing ffmpeg via zypper..."
      zypper install -y ffmpeg || true
    fi
  elif [ "$OS" = "darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      echo -e "      Installing ffmpeg via Homebrew..."
      brew install ffmpeg || true
    fi
  fi

  if command -v ffplay >/dev/null 2>&1; then
    INSTALLED_FFMPEG=true
    echo -e "${GREEN}      Installed ffplay via package manager${NC}"
  fi

  # Zero-root static binary fallback for Linux
  if [ "$INSTALLED_FFMPEG" = false ] && [ "$OS" = "linux" ]; then
    echo -e "      Installing standalone static ffplay binary (zero-root)..."
    TMP_FF_DIR="$(mktemp -d)"
    FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${FFMPEG_ARCH}-gpl.tar.xz"
    
    if curl -fsSL "$FFMPEG_URL" -o "$TMP_FF_DIR/ffmpeg.tar.xz" 2>/dev/null; then
      tar -xf "$TMP_FF_DIR/ffmpeg.tar.xz" -C "$TMP_FF_DIR"
      FF_EXTRACTED_DIR="$(find "$TMP_FF_DIR" -maxdepth 1 -type d -name "ffmpeg-*" | head -n 1)"
      if [ -d "$FF_EXTRACTED_DIR/bin" ]; then
        cp "$FF_EXTRACTED_DIR/bin/ffplay" "$INSTALL_DIR/ffplay" 2>/dev/null || true
        cp "$FF_EXTRACTED_DIR/bin/ffmpeg" "$INSTALL_DIR/ffmpeg" 2>/dev/null || true
        chmod +x "$INSTALL_DIR/ffplay" "$INSTALL_DIR/ffmpeg" 2>/dev/null || true
        INSTALLED_FFMPEG=true
        echo -e "${GREEN}      Installed static ffplay to $INSTALL_DIR/ffplay${NC}"
      fi
    fi
    rm -rf "$TMP_FF_DIR"
  fi

  if ! command -v ffplay >/dev/null 2>&1 && [ ! -f "$INSTALL_DIR/ffplay" ]; then
    echo -e "${YELLOW}      Notice: Could not automatically install ffplay.${NC}"
    echo -e "      Please install ffmpeg using your package manager if audio does not play."
  fi
fi

# 5. Resonate Binary Installation
echo -e "${BLUE}[4/5]${NC} Installing Resonate binary..."
TARGET_BIN="$INSTALL_DIR/$BIN_NAME"

if [ -f "./bin/resonate-standalone" ]; then
  echo -e "      Using local build..."
  cp ./bin/resonate-standalone "$TARGET_BIN"
elif command -v bun >/dev/null 2>&1 && [ -f "./src/index.ts" ]; then
  echo -e "      Compiling standalone binary with Bun..."
  bun build --compile ./src/index.ts --outfile "$TARGET_BIN"
else
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/resonate-${TARGET}"
  echo -e "      Downloading from GitHub Releases: $DOWNLOAD_URL"
  
  if ! curl -fsSL "$DOWNLOAD_URL" -o "$TARGET_BIN" 2>/dev/null; then
    echo -e "${YELLOW}      Online binary not yet available. Building from source via Bun...${NC}"
    if ! command -v bun >/dev/null 2>&1; then
      echo -e "      Installing Bun runtime..."
      curl -fsSL https://bun.sh/install | bash
      export PATH="$HOME/.bun/bin:$PATH"
    fi
    TMP_DIR="$(mktemp -d)"
    git clone --depth=1 "https://github.com/${REPO}.git" "$TMP_DIR"
    (cd "$TMP_DIR" && bun install && bun build --compile ./src/index.ts --outfile "$TARGET_BIN")
    rm -rf "$TMP_DIR"
  fi
fi

chmod +x "$TARGET_BIN"
ln -sf "$TARGET_BIN" "$INSTALL_DIR/lyrical" 2>/dev/null || true

# 6. Configure Shell PATH
echo -e "${BLUE}[5/5]${NC} Verifying PATH environment..."
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    if [ -n "$BASH_VERSION" ] || [ -f "$HOME/.bashrc" ]; then
      if ! grep -q "$INSTALL_DIR" "$HOME/.bashrc" 2>/dev/null; then
        echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$HOME/.bashrc"
      fi
    fi
    if [ -n "$ZSH_VERSION" ] || [ -f "$HOME/.zshrc" ]; then
      if ! grep -q "$INSTALL_DIR" "$HOME/.zshrc" 2>/dev/null; then
        echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$HOME/.zshrc"
      fi
    fi
    if [ -f "$HOME/.config/fish/config.fish" ]; then
      if ! grep -q "$INSTALL_DIR" "$HOME/.config/fish/config.fish" 2>/dev/null; then
        echo "fish_add_path $INSTALL_DIR" >> "$HOME/.config/fish/config.fish"
      fi
    fi
    ;;
esac

echo ""
echo -e "${GREEN}${BOLD}============================================================${NC}"
echo -e "${GREEN}${BOLD}  Resonate and all dependencies successfully installed!     ${NC}"
echo -e "${GREEN}${BOLD}============================================================${NC}"
echo ""
echo -e "Installed binaries in: ${BOLD}$INSTALL_DIR${NC}"
echo -e "  - resonate  : $(which resonate 2>/dev/null || echo "$INSTALL_DIR/resonate")"
echo -e "  - yt-dlp    : $(which yt-dlp 2>/dev/null || echo "$INSTALL_DIR/yt-dlp")"
echo -e "  - ffplay    : $(which ffplay 2>/dev/null || echo "$INSTALL_DIR/ffplay")"
echo ""
echo -e "To start playing, run:"
echo -e "  ${CYAN}${BOLD}resonate${NC}"
echo ""
