#!/usr/bin/env bash
set -e

# ==============================================================================
# Resonate installer
# curl -fsSL https://raw.githubusercontent.com/aman-senpai/resonate/master/install.sh | bash
# ==============================================================================

REPO="aman-senpai/resonate"
INSTALL_DIR="${RESONATE_INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="resonate"
ORIG_PATH="$PATH"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${CYAN}${BOLD}"
echo "============================================================"
echo "  RESONATE - installer"
echo "============================================================"
echo -e "${NC}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH_RAW="$(uname -m)"
NEED_NEW_SHELL=0

case "$ARCH_RAW" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo -e "${RED}Error: unsupported architecture ${ARCH_RAW}${NC}"
    exit 1
    ;;
esac

case "$OS" in
  linux) TARGET="linux-${ARCH}" ;;
  darwin) TARGET="darwin-${ARCH}" ;;
  *)
    echo -e "${RED}Error: unsupported OS ${OS} (Linux and macOS only)${NC}"
    exit 1
    ;;
esac

echo -e "${BLUE}[1/5]${NC} Platform: ${BOLD}${TARGET}${NC}"

mkdir -p "$INSTALL_DIR"

path_contains_install_dir() {
  case ":$ORIG_PATH:" in
    *":${INSTALL_DIR}:"*) return 0 ;;
    *) return 1 ;;
  esac
}

append_once() {
  local file="$1"
  local line="$2"
  mkdir -p "$(dirname "$file")"
  if [ ! -f "$file" ]; then
    touch "$file"
  fi
  if grep -Fqs "$INSTALL_DIR" "$file"; then
    return 0
  fi
  printf '\n# resonate\n%s\n' "$line" >> "$file"
}

if ! path_contains_install_dir; then
  append_once "$HOME/.profile" "export PATH=\"$INSTALL_DIR:\$PATH\""
  append_once "$HOME/.bashrc" "export PATH=\"$INSTALL_DIR:\$PATH\""
  if [ -f "$HOME/.zshrc" ] || [ -n "${ZSH_VERSION:-}" ]; then
    append_once "$HOME/.zshrc" "export PATH=\"$INSTALL_DIR:\$PATH\""
  fi
  if [ -f "$HOME/.config/fish/config.fish" ]; then
    append_once "$HOME/.config/fish/config.fish" "fish_add_path $INSTALL_DIR"
  fi
  NEED_NEW_SHELL=1
fi

export PATH="$INSTALL_DIR:$PATH"

tmp_download() {
  local url="$1"
  local dest="$2"
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/resonate.XXXXXX")"
  if curl -fsSL --retry 3 --retry-delay 1 "$url" -o "$tmp"; then
    mv -f "$tmp" "$dest"
    chmod +x "$dest"
    return 0
  fi
  rm -f "$tmp"
  return 1
}

bin_ok() {
  local bin="$1"
  shift
  command -v "$bin" >/dev/null 2>&1 || return 1
  "$bin" "$@" >/dev/null 2>&1
}

echo -e "${BLUE}[2/5]${NC} yt-dlp (stream extraction)"

YT_DLP_ASSET="yt-dlp_linux"
if [ "$OS" = "darwin" ]; then
  YT_DLP_ASSET="yt-dlp_macos"
elif [ "$ARCH" = "arm64" ]; then
  YT_DLP_ASSET="yt-dlp_linux_aarch64"
fi

if bin_ok yt-dlp --version; then
  echo -e "      found $(command -v yt-dlp)"
else
  echo -e "      downloading ${YT_DLP_ASSET}"
  if tmp_download "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YT_DLP_ASSET}" "$INSTALL_DIR/yt-dlp"; then
    if ! bin_ok "$INSTALL_DIR/yt-dlp" --version; then
      echo -e "${YELLOW}      native yt-dlp failed to run; trying python zipapp${NC}"
      tmp_download "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" "$INSTALL_DIR/yt-dlp" || true
    fi
  fi
  if ! bin_ok yt-dlp --version; then
    echo -e "${RED}Error: yt-dlp install failed (python3 may be required for the zipapp fallback)${NC}"
    exit 1
  fi
  echo -e "${GREEN}      installed $INSTALL_DIR/yt-dlp${NC}"
fi

echo -e "${BLUE}[3/5]${NC} audio engine (ffplay / mpv / ffmpeg)"

have_audio_engine() {
  bin_ok ffplay -version || bin_ok mpv --version || bin_ok ffmpeg -version
}

try_pkg_ffmpeg() {
  if [ "$OS" = "darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      echo -e "      brew install ffmpeg"
      brew install ffmpeg || return 1
    fi
    return 0
  fi

  if ! command -v sudo >/dev/null 2>&1; then
    return 0
  fi
  if ! sudo -n true >/dev/null 2>&1; then
    return 0
  fi

  if command -v dnf >/dev/null 2>&1; then
    echo -e "      sudo dnf install ffmpeg-free"
    sudo -n dnf install -y ffmpeg-free || sudo -n dnf install -y ffmpeg || true
  elif command -v apt-get >/dev/null 2>&1; then
    echo -e "      sudo apt-get install ffmpeg"
    sudo -n apt-get update -qq || true
    sudo -n apt-get install -y ffmpeg || true
  elif command -v pacman >/dev/null 2>&1; then
    echo -e "      sudo pacman -S ffmpeg"
    sudo -n pacman -Sy --noconfirm ffmpeg || true
  elif command -v zypper >/dev/null 2>&1; then
    echo -e "      sudo zypper install ffmpeg"
    sudo -n zypper install -y ffmpeg || true
  elif command -v apk >/dev/null 2>&1; then
    echo -e "      sudo apk add ffmpeg"
    sudo -n apk add ffmpeg || true
  fi
}

install_static_ffmpeg_linux() {
  local jl_arch tarball tmpdir extracted
  if [ "$ARCH" = "arm64" ]; then
    jl_arch="arm64"
  else
    jl_arch="amd64"
  fi
  tarball="ffmpeg-release-${jl_arch}-static.tar.xz"
  tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/resonate-ff.XXXXXX")"
  echo -e "      downloading static ffmpeg (${jl_arch})"
  if ! curl -fsSL --retry 3 --retry-delay 1 \
      "https://johnvansickle.com/ffmpeg/releases/${tarball}" \
      -o "$tmpdir/ffmpeg.tar.xz"; then
    rm -rf "$tmpdir"
    return 1
  fi
  tar -xJf "$tmpdir/ffmpeg.tar.xz" -C "$tmpdir"
  extracted="$(find "$tmpdir" -maxdepth 2 -type f -name ffmpeg | head -n 1)"
  if [ -z "$extracted" ]; then
    rm -rf "$tmpdir"
    return 1
  fi
  cp "$extracted" "$INSTALL_DIR/ffmpeg"
  chmod +x "$INSTALL_DIR/ffmpeg"
  rm -rf "$tmpdir"
  "$INSTALL_DIR/ffmpeg" -version >/dev/null 2>&1
}

if have_audio_engine; then
  if command -v ffplay >/dev/null 2>&1; then
    echo -e "      found $(command -v ffplay)"
  elif command -v mpv >/dev/null 2>&1; then
    echo -e "      found $(command -v mpv)"
  else
    echo -e "      found $(command -v ffmpeg)"
  fi
else
  try_pkg_ffmpeg || true
  if ! have_audio_engine && [ "$OS" = "linux" ]; then
    install_static_ffmpeg_linux || true
  fi
fi

if ! have_audio_engine; then
  echo -e "${RED}Error: no audio engine (need ffplay, mpv, or ffmpeg)${NC}"
  echo "Install ffmpeg, then re-run this script:"
  echo "  Fedora:  sudo dnf install ffmpeg-free"
  echo "  Debian:  sudo apt install ffmpeg"
  echo "  Arch:    sudo pacman -S ffmpeg"
  echo "  macOS:   brew install ffmpeg"
  exit 1
fi

echo -e "${BLUE}[4/5]${NC} resonate binary"
TARGET_BIN="$INSTALL_DIR/$BIN_NAME"
IN_REPO=0
if [ -f "./src/index.ts" ] && [ -f "./package.json" ]; then
  IN_REPO=1
fi

if [ "$IN_REPO" -eq 1 ] && command -v bun >/dev/null 2>&1; then
  echo -e "      compiling with bun"
  bun build --compile ./src/index.ts --outfile "$TARGET_BIN"
elif [ "$IN_REPO" -eq 1 ] && [ -f "./bin/resonate-standalone" ]; then
  echo -e "      using local standalone build"
  cp "./bin/resonate-standalone" "$TARGET_BIN"
else
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/resonate-${TARGET}"
  echo -e "      downloading ${DOWNLOAD_URL}"
  if ! tmp_download "$DOWNLOAD_URL" "$TARGET_BIN"; then
    echo -e "${YELLOW}      release binary missing; building from source${NC}"
    if ! command -v bun >/dev/null 2>&1; then
      echo -e "      installing bun"
      curl -fsSL https://bun.sh/install | bash
      export PATH="$HOME/.bun/bin:$PATH"
    fi
    if ! command -v git >/dev/null 2>&1; then
      echo -e "${RED}Error: git is required to build from source${NC}"
      exit 1
    fi
    TMP_SRC="$(mktemp -d "${TMPDIR:-/tmp}/resonate-src.XXXXXX")"
    git clone --depth=1 "https://github.com/${REPO}.git" "$TMP_SRC"
    (cd "$TMP_SRC" && bun install && bun build --compile ./src/index.ts --outfile "$TARGET_BIN")
    rm -rf "$TMP_SRC"
  fi
fi

chmod +x "$TARGET_BIN"
ln -sf "$TARGET_BIN" "$INSTALL_DIR/lyrical" 2>/dev/null || true

echo -e "${BLUE}[5/5]${NC} verify"
if ! bin_ok "$TARGET_BIN" --version; then
  echo -e "${RED}Error: resonate binary does not run${NC}"
  exit 1
fi
if ! bin_ok yt-dlp --version; then
  echo -e "${RED}Error: yt-dlp does not run${NC}"
  exit 1
fi
if ! have_audio_engine; then
  echo -e "${RED}Error: audio engine verification failed${NC}"
  exit 1
fi
hash -r 2>/dev/null || true

echo ""
echo -e "${GREEN}${BOLD}Installed${NC}"
echo "  resonate : $(command -v resonate 2>/dev/null || echo "$TARGET_BIN")"
echo "  yt-dlp   : $(command -v yt-dlp)"
if command -v ffplay >/dev/null 2>&1; then
  echo "  ffplay   : $(command -v ffplay)"
elif command -v mpv >/dev/null 2>&1; then
  echo "  mpv      : $(command -v mpv)"
else
  echo "  ffmpeg   : $(command -v ffmpeg)"
fi
echo ""
if [ "$NEED_NEW_SHELL" -eq 1 ]; then
  echo -e "${YELLOW}Open a new terminal, or run:${NC}"
  echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
  echo ""
fi
echo -e "Start with: ${CYAN}${BOLD}resonate${NC}"
echo ""
