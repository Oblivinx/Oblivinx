#!/usr/bin/env bash
# Oblivinx3x Build Script — Linux/macOS
# Usage: ./scripts/build.sh [--debug] [--skip-npm]
set -euo pipefail

# ── Parse flags ─────────────────────────────────────────────────
DEBUG=false
SKIP_NPM=false

for arg in "$@"; do
  case $arg in
    --debug)   DEBUG=true ;;
    --skip-npm) SKIP_NPM=true ;;
    --help)
      cat <<EOF
Oblivinx3x Build Script (Linux/macOS)

Usage:
  ./scripts/build.sh             # Release build (optimized)
  ./scripts/build.sh --debug     # Debug build (faster compile)
  ./scripts/build.sh --skip-npm  # Skip npm install

Steps:
  1. Check Rust/Cargo availability
  2. Build ovn-neon native addon
  3. Copy platform binary → .node
  4. npm install (optional)
EOF
      exit 0 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE=$([ "$DEBUG" = true ] && echo "debug" || echo "release")
CARGO_FLAG=$([ "$DEBUG" = true ] && echo "" || echo "--release")

# ── Colors ───────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; GRAY='\033[0;37m'; NC='\033[0m'

echo ""
echo -e "  ${CYAN}╔═══════════════════════════════════════╗${NC}"
echo -e "  ${CYAN}║  Oblivinx3x Build Script (Linux/Mac) ║${NC}"
echo -e "  ${CYAN}╚═══════════════════════════════════════╝${NC}"
echo ""

# ── Step 1: Check dependencies ───────────────────────────────────
echo -e "${YELLOW}[1/4] Checking build dependencies...${NC}"

if ! command -v cargo &>/dev/null; then
  echo -e "  ${RED}✗ Cargo (Rust) is not installed.${NC}"
  echo -e "  ${RED}  Install with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh${NC}"
  exit 1
fi

echo -e "  ${GREEN}✓ $(cargo --version)${NC}"

# ── Step 2: Build ─────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[2/4] Building ovn-neon (${PROFILE} profile)...${NC}"
echo -e "  ${GRAY}This may take a few minutes on first build...${NC}"
echo ""

cd "$ROOT"
cargo build $CARGO_FLAG -p ovn-neon

echo -e "  ${GREEN}✓ Build succeeded${NC}"

# ── Step 3: Copy binary → .node ──────────────────────────────────
echo ""
echo -e "${YELLOW}[3/4] Copying native addon...${NC}"

TARGET_DIR="$ROOT/target/$PROFILE"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"

copy_and_report() {
  local src="$1"
  local dst="$2"
  if [ -f "$src" ]; then
    cp -f "$src" "$dst"
    echo -e "  ${GREEN}✓ $(basename "$src") → $(basename "$dst")${NC}"
    return 0
  fi
  return 1
}

copied=false

if [ "$PLATFORM" = "linux" ]; then
  # Linux: libovn_neon.so → ovn_neon.node
  if copy_and_report "$TARGET_DIR/libovn_neon.so" "$TARGET_DIR/ovn_neon.node"; then
    copied=true
    # Copy to platform package
    ARCH="$(uname -m)"
    if [ "$ARCH" = "aarch64" ]; then
      PKG_DIR="$ROOT/packages/oblivinx3x-linux-arm64-gnu"
    else
      PKG_DIR="$ROOT/packages/oblivinx3x-linux-x64-gnu"
    fi
    [ -d "$PKG_DIR" ] && copy_and_report "$TARGET_DIR/libovn_neon.so" "$PKG_DIR/ovn_neon.node"
  fi

elif [ "$PLATFORM" = "darwin" ]; then
  # macOS: libovn_neon.dylib → ovn_neon.node
  if copy_and_report "$TARGET_DIR/libovn_neon.dylib" "$TARGET_DIR/ovn_neon.node"; then
    copied=true
    # Copy to platform package
    ARCH="$(uname -m)"
    if [ "$ARCH" = "arm64" ]; then
      PKG_DIR="$ROOT/packages/oblivinx3x-darwin-arm64"
    else
      PKG_DIR="$ROOT/packages/oblivinx3x-darwin-x64"
    fi
    [ -d "$PKG_DIR" ] && copy_and_report "$TARGET_DIR/libovn_neon.dylib" "$PKG_DIR/ovn_neon.node"
  fi
fi

if [ "$copied" = false ]; then
  echo -e "  ${RED}✗ Native library not found in target/$PROFILE/${NC}"
  echo -e "  ${RED}  Expected: libovn_neon.so (Linux) or libovn_neon.dylib (macOS)${NC}"
  exit 1
fi

# ── Step 4: npm install ───────────────────────────────────────────
if [ "$SKIP_NPM" = false ]; then
  echo ""
  echo -e "${YELLOW}[4/4] Running npm install...${NC}"
  if command -v npm &>/dev/null; then
    npm install
    echo -e "  ${GREEN}✓ npm install completed${NC}"
  else
    echo -e "  ${GRAY}⚠ npm not found — skipping${NC}"
  fi
else
  echo -e "${GRAY}[4/4] Skipping npm install (--skip-npm)${NC}"
fi

# ── Done ─────────────────────────────────────────────────────────
echo ""
echo -e "  ${GREEN}╔═══════════════════════════════════════╗${NC}"
echo -e "  ${GREEN}║        Build Complete! ✓              ║${NC}"
echo -e "  ${GREEN}╚═══════════════════════════════════════╝${NC}"
echo ""
echo -e "  Native addon: target/${PROFILE}/ovn_neon.node"
echo ""
echo -e "  Quick test:"
echo -e "  ${GRAY}  node --test tests/integration/engine.test.js${NC}"
echo ""
