#!/bin/bash
# ============================================================
# check-before-commit.sh
# Oblivinx3x — Pre-commit verification script
# Jalankan sebelum setiap git commit dan push
# ============================================================

set -e  # stop on any error

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

step() { echo -e "\n${BLUE}=== $1 ===${NC}"; }
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════╗"
echo "║   Oblivinx3x — Pre-Commit Verification      ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"

# ── [1] Format ───────────────────────────────────────────
step "[1/6] cargo fmt"
cargo fmt --all
ok "Code formatted"

# ── [2] Clippy ───────────────────────────────────────────
step "[2/6] cargo clippy"
cargo clippy --all-targets --all-features -- -D warnings
ok "No clippy warnings"

# ── [3] Tests ────────────────────────────────────────────
step "[3/6] cargo test"
cargo test --all
ok "All Rust tests passed"

# ── [4] Build Release ────────────────────────────────────
step "[4/6] cargo build --release"
cargo build --release --all
ok "Release build successful"

# ── [5] Native Addon ─────────────────────────────────────
step "[5/6] Build native addon (ovn-neon)"
cargo build --release -p ovn-neon

if [ -f "target/release/ovn_neon.node" ]; then
    SIZE=$(du -sh target/release/ovn_neon.node | cut -f1)
    ok "Native addon built: target/release/ovn_neon.node ($SIZE)"
else
    fail "ovn_neon.node not found after build!"
fi

# ── [6] Node.js E2E Tests ────────────────────────────────
step "[6/6] Node.js E2E tests"
if [ -d "tests/e2e" ] && [ "$(ls -A tests/e2e 2>/dev/null)" ]; then
    node --test tests/e2e/
    ok "Node.js E2E tests passed"
else
    warn "tests/e2e/ is empty — skipping Node.js tests"
fi

# ── Summary ──────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗"
echo "║   ✅  All checks passed! Ready to commit.    ║"
echo -e "╚══════════════════════════════════════════════╝${NC}"
echo ""
echo "Git status:"
git status --short
echo ""
echo "Staged files:"
git diff --cached --name-only
