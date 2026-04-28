# 16 — PLATFORM & BUILD

> **Audience:** Engine maintainers, distribution / packaging, CI engineers.
> **Status:** Specification (target v0.1 baseline → v1.0 stable cross-platform).
> **Cross refs:** `[[FILE-01]]` storage I/O, `[[FILE-07]]` security, `[[FILE-13]]` API, `[[FILE-17]]` testing.

---

## 1. Purpose

Define how Oblivinx3x is **built, packaged, signed, and distributed** across all supported platforms. This document is the single source for:

* Cargo workspace layout.
* Required toolchains and pinned versions.
* Per-platform feature matrix.
* Cross-compilation recipes.
* Sanitizer / fuzzing / coverage builds.
* Release pipeline (CI/CD).
* Reproducible build guarantees.

---

## 2. Cargo workspace layout

```
oblivinx3x/                               root
├── Cargo.toml                            workspace + shared deps
├── Cargo.lock                            committed (libraries: not committed; we ARE a library + binaries)
├── rust-toolchain.toml                   pinned channel
├── deny.toml                             cargo-deny policy
├── clippy.toml                           lint configuration
├── rustfmt.toml                          formatting
├── crates/
│   ├── ovn-core/                         engine (lib)
│   ├── ovn-format/                       OBE encoding (lib, no_std capable)
│   ├── ovn-storage/                      WAL + buffer pool + B-tree (lib)
│   ├── ovn-query/                        planner + executor (lib)
│   ├── ovn-index/                        secondary indexes (lib)
│   ├── ovn-fts/                          full-text (lib)
│   ├── ovn-vector/                       HNSW (lib)
│   ├── ovn-mvcc/                         transactions (lib)
│   ├── ovn-security/                     crypto, RBAC, KMS (lib)
│   ├── ovn-replication/                  replication / sync (lib)
│   ├── ovn-plugin/                       wasmtime host (lib)
│   ├── ovn-oql/                          parser + lowering (lib)
│   ├── ovn-cli/                          `ovn` binary
│   ├── ovn-server/                       `ovnsd` REST/gRPC sidecar (bin)
│   ├── ovn-neon/                         Node.js bindings (cdylib)
│   ├── ovn-pyo3/                         Python bindings (cdylib)
│   ├── ovn-c/                            C ABI (cdylib + staticlib)
│   ├── ovn-wasm/                         WASM build for browser/edge (cdylib)
│   └── ovn-test/                         shared test fixtures (dev-dep only)
├── tests/
│   ├── integration/                      Node.js end-to-end
│   ├── conformance/                      cross-language
│   └── fuzz/                             cargo-fuzz targets
├── benches/                              criterion benches
├── docs/
├── ovnplanning/                          THIS FOLDER
├── scripts/
│   ├── detect-platform.js
│   ├── ci/
│   ├── release/
│   └── tools/
├── .github/workflows/                    CI definitions
└── README.md
```

### 2.1 Workspace `Cargo.toml`

```toml
[workspace]
resolver  = "2"
members   = [
  "crates/ovn-core", "crates/ovn-format", "crates/ovn-storage",
  "crates/ovn-query", "crates/ovn-index", "crates/ovn-fts",
  "crates/ovn-vector", "crates/ovn-mvcc", "crates/ovn-security",
  "crates/ovn-replication", "crates/ovn-plugin", "crates/ovn-oql",
  "crates/ovn-cli", "crates/ovn-server",
  "crates/ovn-neon", "crates/ovn-pyo3", "crates/ovn-c", "crates/ovn-wasm",
  "crates/ovn-test",
]

[workspace.package]
version       = "0.1.0"
edition       = "2021"
rust-version  = "1.83"
license       = "Apache-2.0 OR MIT"
repository    = "https://github.com/Natz6N/oblivinx3x"
homepage      = "https://oblivinx.dev"
authors       = ["Oblivinx3x Authors"]
keywords      = ["database","embedded","document","nosql","vector"]
categories    = ["database","database-implementations"]

[workspace.dependencies]
# Async runtime
tokio          = { version = "1.38", features = ["rt-multi-thread","macros","sync","fs","time","io-util"] }
futures        = "0.3"
async-trait    = "0.1"

# Concurrency
parking_lot    = "0.12"
crossbeam      = "0.8"
arc-swap       = "1.7"
dashmap        = "6"

# Compression
lz4_flex       = "0.11"
zstd           = "0.13"

# Crypto
ring           = "0.17"          # AES-GCM, HKDF, HMAC
argon2         = "0.5"
ed25519-dalek  = "2"
hkdf           = "0.12"
rand           = "0.8"
chacha20poly1305 = "0.10"
aes-gcm-siv    = "0.11"

# Serialization
serde          = { version = "1", features = ["derive"] }
serde_json     = "1"
bytes          = "1.6"

# Errors
thiserror      = "1"
anyhow         = "1"

# I/O
memmap2        = "0.9"
fs2            = "0.4"

# Hashing
xxhash-rust    = { version = "0.8", features = ["xxh3"] }
crc32c         = "0.6"
blake3         = "1.5"

# Logging / tracing
tracing        = "0.1"
tracing-subscriber = { version = "0.3", features = ["json","env-filter"] }
opentelemetry  = "0.24"
opentelemetry-otlp = "0.17"

# Plugins
wasmtime       = { version = "23", default-features = false, features = ["cranelift","pooling-allocator","async","threads"] }

# CLI
clap           = { version = "4", features = ["derive"] }

# Testing / dev
criterion      = { version = "0.5", features = ["html_reports"] }
proptest       = "1.4"
tempfile       = "3.10"
rstest         = "0.21"

# Misc
once_cell      = "1.19"
smallvec       = "1.13"
ahash          = "0.8"
roaring        = "0.10"
hdrhistogram   = "7.5"
```

### 2.2 Per-crate `Cargo.toml` (example: `ovn-core`)

```toml
[package]
name        = "ovn-core"
version.workspace      = true
edition.workspace      = true
rust-version.workspace = true
license.workspace      = true
description = "Oblivinx3x core engine"

[lib]
crate-type = ["rlib"]

[features]
default       = ["std","compression-zstd","encryption","tracing"]
std           = []
no_std        = []                                    # for ovn-format only
compression-lz4   = ["lz4_flex"]
compression-zstd  = ["zstd"]
encryption    = ["ring","aes-gcm-siv","argon2","hkdf"]
fts           = []
vector        = []
plugin-wasm   = ["wasmtime"]
mvcc          = []
replication   = []
metrics       = []
otel          = ["opentelemetry","opentelemetry-otlp"]
ssr-mmap      = ["memmap2"]
io-uring      = []

[dependencies]
ovn-format    = { path = "../ovn-format" }
ovn-storage   = { path = "../ovn-storage" }
ovn-query     = { path = "../ovn-query" }
ovn-index     = { path = "../ovn-index" }
# ...
serde.workspace = true
thiserror.workspace = true
tokio.workspace = true
```

### 2.3 `rust-toolchain.toml`

```toml
[toolchain]
channel    = "1.83.0"
components = ["rustc","cargo","rust-std","rustfmt","clippy","rust-src"]
profile    = "default"
```

Pinning the toolchain locks reproducibility across developer machines and CI.

---

## 3. Supported platforms (target matrix)

| Tier | Platform                              | Trigger        | Notes                                         |
| ---- | ------------------------------------- | -------------- | --------------------------------------------- |
| 1    | `x86_64-unknown-linux-gnu`            | Every PR       | Primary dev target                            |
| 1    | `aarch64-unknown-linux-gnu`           | Every PR       | ARM servers, Raspberry Pi 4/5                 |
| 1    | `x86_64-pc-windows-msvc`              | Every PR       | Win 10/11; uses IOCP + FILE_FLAG_WRITE_THROUGH |
| 1    | `aarch64-apple-darwin`                | Every PR       | Apple Silicon; F_FULLFSYNC required           |
| 1    | `x86_64-apple-darwin`                 | Nightly        | Intel Mac fallback                            |
| 2    | `x86_64-unknown-linux-musl`           | Nightly        | Static binary; alpine                         |
| 2    | `aarch64-unknown-linux-musl`          | Nightly        |                                               |
| 2    | `aarch64-apple-ios`                   | Nightly        | Mobile static lib                             |
| 2    | `aarch64-linux-android`               | Nightly        | Mobile JNI                                    |
| 2    | `wasm32-unknown-unknown`              | Every PR       | Browser via OPFS                              |
| 2    | `wasm32-wasip1`                       | Nightly        | Server-side wasm                              |
| 3    | `x86_64-pc-windows-gnu`               | Manual         | MinGW; not officially supported               |
| 3    | `riscv64gc-unknown-linux-gnu`         | Manual         | Experimental                                  |

* **Tier 1**: full test suite passes; release artifacts produced.
* **Tier 2**: build green, smoke tests pass; release artifacts produced.
* **Tier 3**: build green; user-supported.

---

## 4. Per-platform feature & implementation differences

| Concern                | Linux                          | macOS                              | Windows                                      | iOS / Android                  | WASM                          |
| ---------------------- | ------------------------------ | ---------------------------------- | -------------------------------------------- | ------------------------------ | ----------------------------- |
| File durability        | `fdatasync`, io_uring (≥ 5.10) | `F_FULLFSYNC`                      | `FlushFileBuffers` + `FILE_FLAG_WRITE_THROUGH` | `fsync` / via NDK              | OPFS async API                |
| Async I/O              | io_uring → epoll fallback      | kqueue                             | IOCP                                         | epoll/kqueue per OS            | event-loop                    |
| Memory mapping         | `mmap` (MAP_PRIVATE / SHARED)  | `mmap`                             | `MapViewOfFile`                              | `mmap`                         | not available                 |
| Direct I/O             | O_DIRECT (opt-in)              | `F_NOCACHE`                        | `FILE_FLAG_NO_BUFFERING`                     | platform `O_DIRECT`            | n/a                           |
| Threading              | pthread                        | pthread                            | Win32 thread                                 | pthread / NDK                  | single-thread (workers TBD)   |
| File locking           | `fcntl` advisory               | `flock`                            | `LockFileEx`                                 | `fcntl`                        | not available                 |
| TLS source             | system OpenSSL → rustls        | SecureTransport → rustls            | SChannel → rustls                           | platform                       | browser                       |
| Build complexity       | low                             | medium                             | medium                                       | high                           | medium                        |

### 4.1 cfg flags used

```rust
#[cfg(target_family = "unix")]
#[cfg(target_os = "linux")]
#[cfg(target_os = "macos")]
#[cfg(target_os = "windows")]
#[cfg(target_os = "ios")]
#[cfg(target_os = "android")]
#[cfg(target_arch = "wasm32")]
#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
```

---

## 5. Cross-compilation recipes

### 5.1 Linux → Windows MSVC (via xwin)

```bash
cargo install cargo-xwin
cargo xwin build --release --target x86_64-pc-windows-msvc -p ovn-cli
```

### 5.2 macOS → Linux (via cross)

```bash
cargo install cross --git https://github.com/cross-rs/cross
cross build --release --target aarch64-unknown-linux-gnu -p ovn-server
```

### 5.3 Linux → musl (static)

```bash
rustup target add x86_64-unknown-linux-musl
RUSTFLAGS='-C target-feature=+crt-static' \
  cargo build --release --target x86_64-unknown-linux-musl -p ovn-cli
```

### 5.4 → wasm32

```bash
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown -p ovn-wasm \
   --no-default-features --features "compression-lz4 fts mvcc"
wasm-bindgen target/wasm32-unknown-unknown/release/ovn_wasm.wasm \
   --out-dir pkg/ --target web
```

### 5.5 → Android

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
cargo install cargo-ndk
cargo ndk -t arm64-v8a -t armeabi-v7a -o jniLibs build --release -p ovn-c
```

### 5.6 → iOS

```bash
rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim
cargo build --release --target aarch64-apple-ios -p ovn-c
# Combine into XCFramework:
xcodebuild -create-xcframework \
   -library target/aarch64-apple-ios/release/libovn_c.a \
   -library target/aarch64-apple-ios-sim/release/libovn_c.a \
   -output build/Oblivinx.xcframework
```

---

## 6. Build profiles

### 6.1 `Cargo.toml` profile customizations

```toml
[profile.dev]
opt-level     = 0
debug         = "full"
incremental   = true
overflow-checks = true

[profile.dev.package."*"]                    # speed up deps in dev
opt-level     = 1

[profile.release]
opt-level     = 3
lto           = "thin"
codegen-units = 1
panic         = "abort"
strip         = "symbols"
debug         = false

[profile.release-with-debug]                 # for profiling
inherits      = "release"
debug         = "line-tables-only"
strip         = false

[profile.bench]
inherits      = "release"
debug         = "line-tables-only"

[profile.test]
opt-level     = 0
debug         = "full"

[profile.fuzz]
inherits      = "release"
opt-level     = 3
codegen-units = 1
debug         = "full"
overflow-checks = true
```

### 6.2 Sanitizer profiles

Run with nightly:

```bash
RUSTFLAGS="-Z sanitizer=address" cargo +nightly test -p ovn-storage --target x86_64-unknown-linux-gnu
RUSTFLAGS="-Z sanitizer=thread"  cargo +nightly test -p ovn-mvcc    --target x86_64-unknown-linux-gnu
RUSTFLAGS="-Z sanitizer=memory -Z sanitizer-memory-track-origins" \
                                 cargo +nightly test -p ovn-format  --target x86_64-unknown-linux-gnu
RUSTFLAGS="-Z sanitizer=leak"    cargo +nightly test -p ovn-core    --target x86_64-unknown-linux-gnu
```

ThreadSanitizer is required green for any change touching `ovn-mvcc`, `ovn-storage` (buffer pool), or `ovn-replication`.

### 6.3 Code coverage

```bash
cargo install cargo-llvm-cov
cargo llvm-cov --workspace --html --output-dir target/coverage
cargo llvm-cov --workspace --lcov --output-path target/coverage/lcov.info
```

CI uploads to Codecov; required minimum **70% line coverage**, **60% branch coverage**.

---

## 7. Fuzzing

```bash
cargo install cargo-fuzz
cd crates/ovn-format
cargo +nightly fuzz run obe_decode --release -- -max_total_time=600
```

Fuzz targets (initial set):

| Target              | Crate          | What it fuzzes                          |
| ------------------- | -------------- | --------------------------------------- |
| `obe_decode`        | ovn-format     | OBE deserializer                        |
| `oql_parse`         | ovn-oql        | Lexer + parser                          |
| `wal_replay`        | ovn-storage    | WAL recovery on garbled bytes           |
| `index_key_decode`  | ovn-index      | Composite key parser                    |
| `compression_round` | ovn-storage    | LZ4/Zstd round trip                     |
| `fts_query`         | ovn-fts        | Query parser & analyzer                 |
| `vector_kdtree`     | ovn-vector     | HNSW search invariant                   |
| `crdt_merge`        | ovn-replication| CRDT op merge associativity/commutativity |

CI runs `--max_total_time=120` per target on every PR; nightly job runs 1 h per target.

---

## 8. CI/CD pipeline

### 8.1 GitHub Actions structure

```
.github/workflows/
├── ci.yml                      every PR — build+test+lint matrix
├── nightly.yml                 nightly — full sanitizers, fuzz, coverage
├── release.yml                 on tag — build artifacts, sign, publish
├── docs.yml                    on push main — render mdbook → gh-pages
└── security-scan.yml           weekly — cargo-audit, cargo-deny, gitleaks
```

### 8.2 `ci.yml` matrix (sketch)

```yaml
name: CI
on: [pull_request, push]
jobs:
  build-test:
    strategy:
      fail-fast: false
      matrix:
        target: [
          x86_64-unknown-linux-gnu,
          aarch64-unknown-linux-gnu,
          x86_64-pc-windows-msvc,
          aarch64-apple-darwin,
        ]
        profile: [dev, release]
    runs-on: ${{ matrix.target == 'aarch64-apple-darwin' && 'macos-14'
              || matrix.target == 'x86_64-pc-windows-msvc' && 'windows-latest'
              || 'ubuntu-22.04' }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.83.0
        with: { components: rustfmt,clippy }
      - uses: Swatinem/rust-cache@v2
      - name: cargo fmt
        run: cargo fmt --all --check
      - name: cargo clippy
        run: cargo clippy --workspace --all-targets -- -D warnings
      - name: cargo build
        run: cargo build --workspace --target ${{ matrix.target }} --profile ${{ matrix.profile }}
      - name: cargo test
        run: cargo test --workspace --target ${{ matrix.target }} --profile ${{ matrix.profile }}
      - name: cargo deny
        run: cargo deny check
      - name: integration tests
        if: matrix.target == 'x86_64-unknown-linux-gnu' && matrix.profile == 'release'
        run: |
          cd crates/ovn-neon && npm ci && npm run build
          node tests/integration/engine.test.js
```

### 8.3 `release.yml` (excerpt)

```yaml
name: Release
on:
  push:
    tags: ["v*.*.*"]
jobs:
  build-artifacts:
    strategy:
      matrix:
        target: [ ... all tier-1+2 targets ... ]
    runs-on: ${{ ... pick runner ... }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.83.0
      - run: cargo build --release --target ${{ matrix.target }} -p ovn-cli -p ovn-server
      - name: Strip & package
        run: scripts/release/package.sh ${{ matrix.target }}
      - name: Sign
        env: { SIGNING_KEY: ${{ secrets.SIGNING_KEY }} }
        run: scripts/release/sign.sh ${{ matrix.target }}
      - uses: actions/upload-artifact@v4

  publish:
    needs: build-artifacts
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/download-artifact@v4
      - uses: softprops/action-gh-release@v2
        with: { files: artifacts/* }
      - name: Publish crates.io
        run: scripts/release/cargo_publish.sh
      - name: Publish npm
        run: scripts/release/npm_publish.sh
      - name: Publish PyPI
        run: scripts/release/pypi_publish.sh
```

---

## 9. Reproducible builds

Goals:

* Same source + toolchain version → byte-identical artifact (modulo timestamps).

Required practices:

1. **Pinned toolchain** (`rust-toolchain.toml`).
2. **Pinned dependencies** (`Cargo.lock` committed).
3. **`SOURCE_DATE_EPOCH`** env var honored by build scripts.
4. **No system clock embedding** in build (no `chrono::Utc::now()` in `build.rs`).
5. **Strip embedded paths** with `RUSTFLAGS="--remap-path-prefix"`:
   ```
   RUSTFLAGS="--remap-path-prefix $PWD=/build/oblivinx3x"
   ```
6. **Vendor dependencies** for offline builds:
   ```
   cargo vendor > .cargo/config.toml.vendored
   ```

Verification: `scripts/release/diffoscope_check.sh` compares two CI runs; releases require 0-byte diff.

---

## 10. Signing & supply chain

### 10.1 Artifact signing

* **Linux** binaries: minisign + cosign (Sigstore).
* **macOS** dmg / pkg: Apple Developer ID + notarization.
* **Windows**: Authenticode, Microsoft cross-cert.
* **npm package**: `npm sign-package` (or sigstore JS).
* **PyPI wheels**: PEP 740 attestations via Sigstore.

### 10.2 SBOM

Each release ships:

* `oblivinx3x-<version>-sbom.cdx.json` (CycloneDX)
* `oblivinx3x-<version>-sbom.spdx.json` (SPDX 2.3)

Generated via `cargo sbom` + `cyclonedx-bom`. Listed in GitHub release notes.

### 10.3 Provenance (SLSA)

Aim for **SLSA Level 3** by v1.0:

* Builds run on hosted GitHub-managed runners (no self-hosted modifications).
* Provenance attestation generated via `slsa-framework/slsa-github-generator`.

### 10.4 cargo-deny policy (`deny.toml`)

```toml
[advisories]
vulnerability = "deny"
unmaintained  = "warn"
yanked        = "deny"

[licenses]
unlicensed    = "deny"
allow         = ["MIT","Apache-2.0","Apache-2.0 WITH LLVM-exception","BSD-2-Clause","BSD-3-Clause","ISC","Unicode-DFS-2016","Zlib","CC0-1.0"]
copyleft      = "deny"

[bans]
multiple-versions = "warn"
deny = [
  { name = "openssl-sys" },                # prefer rustls
  { name = "chrono", version = "<0.4.34" } # CVE-2024-2400x band
]

[sources]
unknown-registry = "deny"
unknown-git      = "deny"
```

---

## 11. Linting & formatting

### 11.1 `rustfmt.toml`

```toml
edition           = "2021"
max_width         = 100
hard_tabs         = false
tab_spaces        = 4
newline_style     = "Unix"
use_field_init_shorthand = true
use_try_shorthand = true
imports_granularity = "Crate"
group_imports     = "StdExternalCrate"
reorder_imports   = true
```

### 11.2 `clippy.toml`

```toml
msrv = "1.83"
cognitive-complexity-threshold = 30
type-complexity-threshold = 250
too-many-arguments-threshold = 8
```

### 11.3 Required clippy rules (deny in CI)

```
-D warnings
-D clippy::correctness
-D clippy::suspicious
-D clippy::style
-D clippy::complexity
-D clippy::perf
-W clippy::pedantic           # warn-only
-A clippy::module_name_repetitions
-A clippy::missing_errors_doc
```

---

## 12. Documentation build

* Crate docs: `cargo doc --workspace --no-deps`.
* User guide: mdBook in `docs/`, deployed to GitHub Pages.
* API reference: REST OpenAPI in `docs/openapi.yaml`, rendered via Redoc.
* OQL grammar in `docs/oql.ebnf` (extracted from §2 here).

CI fails if `cargo doc` emits warnings (`RUSTDOCFLAGS="-D warnings"`).

---

## 13. Native bindings build

### 13.1 Node.js (Neon)

```bash
cd crates/ovn-neon
npm ci
npm run build           # runs `cargo-cp-artifact -nc lib/index.node ...`
npm test
npm pack
```

Pre-built binaries published per platform via `@neon-rs/load`:

```
oblivinx3x-linux-x64-gnu
oblivinx3x-linux-arm64-gnu
oblivinx3x-darwin-x64
oblivinx3x-darwin-arm64
oblivinx3x-win32-x64-msvc
oblivinx3x-win32-arm64-msvc
oblivinx3x-android-arm64-eabi
```

### 13.2 Python (PyO3)

```bash
pip install maturin
maturin build --release -m crates/ovn-pyo3/Cargo.toml --target x86_64-unknown-linux-gnu
```

`maturin publish` for PyPI; `manylinux2014` images via `quay.io/pypa/manylinux2014_x86_64`.

### 13.3 C ABI

```bash
cargo build --release -p ovn-c
# produces:
target/release/libovn_c.so          (Linux)
target/release/libovn_c.dylib       (macOS)
target/release/ovn_c.dll            (Windows)
target/release/libovn_c.a           (static archive)
```

`scripts/build/cbindgen.sh` regenerates `include/oblivinx.h`.

---

## 14. Distribution channels

| Channel             | Format           | Signed by         | Cadence    |
| ------------------- | ---------------- | ----------------- | ---------- |
| GitHub Releases     | tarball / zip    | Sigstore          | per tag    |
| crates.io           | source crates    | crate owners      | per tag    |
| npm                 | tarball + binaries | sigstore JS    | per tag    |
| PyPI                | wheels           | sigstore (PEP 740)| per tag    |
| Homebrew tap        | formula → bottle | tap maintainer    | per tag    |
| Docker Hub          | OCI image        | cosign            | per tag    |
| GHCR                | OCI image        | cosign            | per tag + nightly |
| Snap (Ubuntu)       | snap             | Snap Store        | per tag    |
| Chocolatey          | nupkg            | Chocolatey        | per tag    |
| Linux distros       | (community)      | distro maintainers| varies     |

### 14.1 Docker image

`Dockerfile` (multi-stage):

```dockerfile
FROM --platform=$BUILDPLATFORM rust:1.83-bookworm AS build
ARG TARGETPLATFORM
WORKDIR /src
COPY . .
RUN ./scripts/ci/docker-build.sh "$TARGETPLATFORM"

FROM gcr.io/distroless/cc-debian12 AS runtime
COPY --from=build /src/dist/ovn /usr/local/bin/ovn
COPY --from=build /src/dist/ovnsd /usr/local/bin/ovnsd
USER 65532:65532
EXPOSE 7474
ENTRYPOINT ["/usr/local/bin/ovnsd"]
CMD ["--data-dir","/data","--listen","0.0.0.0:7474"]
```

Built for `linux/amd64,linux/arm64`.

---

## 15. Versioning policy

* **SemVer** for crates and packages.
* `0.x.y` → breaking allowed in minor; documented in `CHANGELOG.md`.
* `1.0.0+` → breaking only in major.
* **MSRV** (Minimum Supported Rust Version): bumped only in minor; current `1.83`.
* **Wire/format/ABI** versions tracked separately (see `[[FILE-13]]` §11).

Tag format: `v0.4.1`. Release notes generated from CHANGELOG + auto-collected commit prefixes (`feat:`, `fix:`, `docs:`).

---

## 16. Local developer environment

### 16.1 Prerequisites

* Rust 1.83 (via `rustup`)
* Node 20 LTS (for Neon + integration tests)
* CMake 3.20+ (some FFI deps)
* Python 3.11+ (for PyO3 build)
* `protoc` 25+ (for gRPC generation)
* On Windows: VS Build Tools 2022 with C++ workload; `LLVM` for bindgen

### 16.2 First-time setup

```bash
git clone https://github.com/Natz6N/oblivinx3x
cd oblivinx3x
./scripts/dev/bootstrap.sh
# Installs rustup components, npm deps, sets up git hooks
```

### 16.3 Common commands

```bash
make check        # cargo check --workspace
make test         # full test suite
make bench        # criterion benches
make doc          # cargo doc + mdbook
make fuzz-quick   # 60 s of each fuzz target
make release      # local release build
```

---

## 17. Tradeoffs

| Decision                              | Chosen                          | Alternative              | Why                                  |
| ------------------------------------- | ------------------------------- | ------------------------ | ------------------------------------ |
| `panic = "abort"` in release          | Yes                             | unwind                   | Smaller binary; no UB across FFI      |
| LTO `thin`                            | Yes                             | `fat`                    | Build time cost vs marginal gain      |
| `codegen-units = 1`                   | Release only                    | default 16               | Best optimization, slow build         |
| `parking_lot`                         | Yes                             | std `Mutex`              | Faster, smaller, predictable          |
| `rustls` over OpenSSL                 | Yes                             | system crypto            | Memory safety, single TLS impl        |
| Pinned toolchain                      | Yes                             | floating                 | Reproducibility                       |
| GitHub Actions only                   | Yes (single CI)                 | multi-CI                 | Simplicity; SLSA L3 path              |
| Distroless base image                 | Yes                             | Alpine                   | Smaller attack surface                |
| Strip debug info in release           | Yes                             | Keep                     | Smaller artifact; debug profile exists |

---

## 18. Open questions & future

* **`no_std` for `ovn-format`** to enable embedded MCU integration.
* **Wasm threading** (wasi-threads) once stabilized in browsers.
* **Apple WebKit bytecode** explored for iOS plugin sandbox.
* **Linux `BLAKE3` SIMD acceleration** path on AVX-512.
* **GPU acceleration** for vector index (CUDA / Metal / ROCm) as optional crate.

---

## 19. Cross-references

* `[[FILE-01]]` — per-platform I/O backends called out here.
* `[[FILE-07]]` — crypto crates pinned to platform-friendly options.
* `[[FILE-13]]` — bindings produced by build pipeline.
* `[[FILE-17]]` — sanitizer & fuzz targets exercised in CI.
* `[[FILE-20]]/006` — ADR for HNSW vendor (vector index dependency choice).

*End of `16-PLATFORM-BUILD.md` — 590 lines.*
