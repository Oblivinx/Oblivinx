# 07 — SECURITY LAYER

> Encryption (at rest, in transit, field-level), key derivation, RBAC,
> row-level security, audit log, query injection protection, rate
> limiting, secure delete, and integrity verification.
> Cross-references: `[[FILE-01]]` (page encryption), `[[FILE-02]]` (WAL
> encryption), `[[FILE-03]]` (encrypted OBE tag), `[[FILE-13]]` (API
> auth), `[[FILE-20]]`/003 (encryption ADR).

---

## 1. Threat Model

We protect against:

- **Disk theft / cloud snapshot leak** — file-at-rest encryption with
  authenticated cipher.
- **Network eavesdropping** — TLS 1.3 only, optional mutual TLS.
- **Privileged-process key recovery** — we never persist plaintext keys;
  KMS optional.
- **SQL/MQL injection** — parameterized queries; no string interpolation
  on user input.
- **Side-channel inference on encrypted fields** — searchable encryption
  with documented leakage bounds.
- **Tampered audit log** — HMAC chain with periodic anchor.
- **Brute-force credentials / abuse** — rate limiting + lockout.

Out of scope:

- **Memory-resident attacks** (cold-boot, Rowhammer): the engine assumes
  the process is trusted while running. Use OS-level protection
  (mlock, secure enclaves) at the application layer.
- **Compromised plugin code** running inside the engine: see
  `[[FILE-14]]` §4 for the WASM sandbox boundary.

---

## 2. Encryption at Rest

### 2.1 Cipher choice — AES-256-GCM-SIV

Default cipher: **AES-256-GCM-SIV** (RFC 8452). Reasons:

- **Nonce-misuse-resistant.** With our 12-byte nonce derived from page
  id + counter, accidental nonce reuse degrades to authenticated
  determinism rather than catastrophic plaintext recovery.
- **Hardware support.** AES-NI on x86_64 → ~1.5 GB/s encryption per
  core; ARMv8 Crypto Extensions on aarch64 → ~1.0 GB/s.
- **Authentication.** 16-byte GCM tag detects tampering, including
  partial corruption.

Alternative cipher selectable via `pragma encryption_cipher`:

- `chacha20_poly1305` — for ARM cores without Crypto Extensions
  (Cortex-A53 baseline) where ChaCha20 outperforms AES.
- `aes_256_gcm` — strictly RFC 5288 AES-GCM; **not recommended**
  unless required for FIPS compliance.

### 2.2 Key derivation

Master key is derived from a passphrase via Argon2id:

```
master_key = Argon2id(
    passphrase,
    salt    = file_header.hkdf_salt (32 B),
    m       = 65536 KiB,            # 64 MiB memory
    t       = 3,                    # 3 iterations
    p       = 4,                    # 4 parallel lanes
    out_len = 32                    # 256-bit
)
```

`m`, `t`, `p` are tunable per-database (recorded in extension TLV
`0x06`); embedded profile uses `m=4096, t=2, p=1` to fit MCU memory.

From the master key, sub-keys are derived via HKDF-SHA256:

```
K_data    = HKDF(master_key, "ovn:data:v1", 32)
K_wal     = HKDF(master_key, "ovn:wal:v1",  32)
K_index   = HKDF(master_key, "ovn:idx:v1",  32)
K_audit   = HKDF(master_key, "ovn:audit:v1",32)
K_field_n = HKDF(master_key, b"ovn:field:" || field_path, 32)
```

Sub-key isolation means a leaked WAL key cannot decrypt audit logs.

### 2.3 Page-level encryption

Each data-region page is encrypted **after** compression and **before**
CRC:

```
plaintext  = page_payload  (after compression if enabled)
nonce      = (4 B random per file) || (8 B page_id, BE)
            = 12 bytes total
ciphertext = AES-256-GCM-SIV.encrypt(K_data, nonce, plaintext, AAD = page_header[0..16])
auth_tag   = GCM tag (16 B, included in ciphertext)
```

The 4-byte random per-file portion of the nonce is the
`encryption_iv` in the file header. This means two databases with the
same key + same page id + same content still produce different
ciphertexts.

#### Page layout when encrypted

```
+----------+--------------------+
| Page hdr | encrypted payload  |
| 64 B     | PAGE_SIZE - 64 B   |
+----------+--------------------+
```

The page header itself is **not** encrypted (so the engine can identify
page type and follow chains without decrypt). Sensitive fields in the
header (LSN, page id) are not secret. Tampering with header detected
via `auth_tag` (header is in AAD) → decrypt fails.

### 2.4 Key rotation

```
db.rotate_key(new_passphrase, opts)
```

Algorithm:

1. Acquire exclusive DB lock.
2. Derive new master key, sub-keys.
3. For each page in the data region:
   - Decrypt with old K_data, encrypt with new K_data, write back.
   - Append `WAL_REC_KEY_ROTATION { page_id, new_lsn }`.
4. Update file header: bump `kdf_salt` (TLV) if requested, update
   `encryption_iv`, recompute header tag.
5. fsync everything, commit.

Long-running; can be paused/resumed (state persisted as a TLV entry).
Throughput limited by encrypt/decrypt cost (~700 MB/s sustained on
modern x86).

### 2.5 External KMS

`pragma key_provider = "kms_aws|kms_gcp|kms_azure|vault|file"`. The
engine asks the provider for `unwrap(wrapped_master_key)` at open and
holds the unwrapped key in mlock'd memory. On close, key is zeroized.

Wrapped master key envelope:

```
struct WrappedMasterKey {
    provider:  String,              // "aws-kms", "vault", ...
    key_arn:   String,              // provider-specific identifier
    wrapped:   Vec<u8>,             // ciphertext from provider
    auth_data: Option<Vec<u8>>,     // KMS context, attestation
}
```

Stored in a sidecar file `<db>.key.json` (not in `.ovn2`) to allow
revocation by deleting the sidecar.

---

## 3. Field-Level Encryption (FLE)

Encrypts individual document fields. Stored in OBE as
`ENCRYPTED (0x1A)` envelopes (`[[FILE-03]]` §5.8).

### 3.1 Modes

- **Randomized (RAND):** distinct ciphertexts per write, even for equal
  plaintexts. Hides equality. Cannot index.
- **Deterministic (DET):** same plaintext → same ciphertext per
  collection key. Can index for equality.
- **Range (planned v1.1):** order-preserving / order-revealing
  encryption (OPE/ORE) using OBE2 layered cipher. Leaks order; opt-in.
- **Searchable substring (planned v1.1):** computes encrypted keyword
  index; leaks search frequency.

### 3.2 Per-field key derivation

```
K_field = HKDF(master_key, "ovn:field:" || coll_id || ":" || field_path, 32)
nonce   = (4 B random) || (8 B HMAC(K_field, doc_id || version_lsn) low bits)
```

Deterministic mode uses `nonce = HMAC(K_field, plaintext)[:12]` — same
plaintext → same nonce → same ciphertext.

### 3.3 Encrypted query operators

```
{ ssn: { $eq: "123-45-6789" } }
```

When `ssn` has a DET-encrypted index, the query rewrites to:

```
{ ssn: { $eq: ENCRYPT_DET(K_ssn, "123-45-6789") } }
```

then performs a normal index lookup over ciphertext. The application
never handles plaintext on the wire (TLS termination).

---

## 4. Encryption in Transit

When the REST API server (`[[FILE-13]]` §3) is enabled:

### 4.1 TLS configuration

- **Protocol:** TLS 1.3 only. TLS 1.2 disabled by default; enable via
  `pragma tls_min_version = "1.2"` for legacy clients.
- **Cipher suites:** `TLS_AES_256_GCM_SHA384`,
  `TLS_CHACHA20_POLY1305_SHA256`. SHA384 first to bias AES-NI hardware.
- **Key exchange:** X25519 + secp384r1 (hybrid), pinned curves.
- **Certificate:** ECDSA P-256 default; RSA 4096 fallback.
- **Mutual TLS:** `pragma tls_require_client_cert = true`. Client
  certificates verified against `pragma tls_client_ca_path`.
- **Certificate pinning:** SHA-256 pin list in `pragma tls_pinned_spki`
  for embedded clients.

### 4.2 OCSP / CRL

OCSP stapling enabled by default; CRL fallback. Cached for 24 hours.
Failures fall back to soft-fail mode (warning) unless
`pragma tls_strict_revocation = true`.

---

## 5. RBAC (Role-Based Access Control)

### 5.1 User model

```rust
pub struct User {
    pub user_id: u64,
    pub username: String,
    pub password_hash: PasswordHash,    // Argon2id
    pub roles: Vec<RoleId>,
    pub created_at: HLC,
    pub last_login_at: Option<HLC>,
    pub status: UserStatus,             // Active/Locked/Expired
    pub metadata: BTreeMap<String, String>,
}
```

Stored in the system collection `_obx_users` (encrypted at rest).

### 5.2 Role model

```rust
pub struct Role {
    pub role_id: u64,
    pub name: String,
    pub permissions: Vec<Permission>,
    pub collection_patterns: Vec<GlobPattern>,
    pub inherits: Vec<RoleId>,
}

pub enum Permission {
    Read, Write, Delete, Admin, Backup, Schema,
    Index, Audit, Plugin, Pragma,
    UserCreate, UserModify, UserDelete,
    RoleCreate, RoleModify, RoleDelete,
}
```

### 5.3 Permission resolution

```text
permitted(user, action, resource):
    roles = user.roles ∪ inherited(user.roles)
    for role in roles:
        if action ∈ role.permissions and matches(role.collection_patterns, resource):
            return Allow
    return Deny
```

### 5.4 Built-in roles

```
admin           : all permissions
readwrite       : Read + Write + Delete on all collections
readonly        : Read on all collections
schemaowner     : Schema + Index on all collections
backup_operator : Backup + Read on all collections
auditor         : Audit + Read on _obx_audit
```

### 5.5 Attribute-based extension (ABAC)

Roles may carry conditional expressions:

```json
{
  "name": "regional_manager",
  "conditions": {
    "$current_user.region": { "$eq": "$resource.region" }
  }
}
```

Conditions are evaluated against the request context (current user,
client IP, request time) and the resource (collection, document).

---

## 6. Authentication

### 6.1 Password hashing

Argon2id with the same parameters as the master key (§2.2) but
per-user salts (16 random bytes stored alongside hash). Output 32
bytes.

### 6.2 Session tokens

- **JWT** for short-lived sessions:
  - Algorithm: `RS256` (asymmetric) for distributed verification, or
    `HS256` (symmetric) for embedded.
  - Claims: `sub` (user_id), `roles`, `iat`, `exp` (1h default), `jti`
    (random; for revocation).
  - Signing key from `K_jwt_signing` HKDF derivation.
- **Refresh tokens** (opaque 32 bytes) stored in `_obx_sessions`,
  exp 30 days, revocable by deletion.

### 6.3 Login flow

```
POST /v1/auth/login {username, password}
  → server: verify hash; issue {access_token, refresh_token, expires_in}
POST /v1/auth/refresh {refresh_token}
  → server: rotate refresh, issue new access
POST /v1/auth/logout {refresh_token}
  → server: delete session row
```

### 6.4 Login throttling

Per username + per IP token bucket (5 attempts / 60s; bucket capacity
5, refill rate 1/12s). After exhaustion: 30s lockout doubling on
subsequent failures (max 1 hour).

Failed attempts logged to audit (`§8`).

---

## 7. Row-Level Security (RLS)

Per-collection policies that filter every query and write.

```js
db.users.createPolicy({
  name: "owner_only",
  filter: { owner_id: "$current_user.id" },
  applies_to: ["read", "update", "delete"]
});
```

### 7.1 Policy enforcement

The query compiler injects `policy.filter` as an AND clause into every
applicable query:

```
SELECT * FROM users WHERE active = true
   →  SELECT * FROM users WHERE active = true AND owner_id = $current_user.id
```

For writes:

- `insert`: validate the new doc satisfies the filter (else reject).
- `update`: compose policy filter into the update predicate; updates
  outside policy fail with `OvnError::PolicyViolation`.

### 7.2 Bypass

Roles with the `Admin` permission bypass RLS by default; this can be
disabled via `pragma rls_strict = true` (no role bypass).

### 7.3 Performance impact

The policy expression is treated like any other predicate and pushed
into the planner; if it lands on an indexed field it costs nothing
extra. Otherwise it adds a per-doc filter step.

---

## 8. Audit Log

### 8.1 Record format

Append-only stream in `PAGE_TYPE_AUDIT_LOG` pages, keyed by HLC
timestamp. Format per record:

```rust
pub struct AuditRecord {
    pub seq:           u64,           // monotonic per-DB sequence
    pub timestamp:     HLC,
    pub user_id:       u64,
    pub session_id:    Option<Vec<u8>>,
    pub action:        AuditAction,   // Read/Write/Delete/Login/...
    pub resource:      String,        // "coll:users/doc:6...0"
    pub success:       bool,
    pub error_code:    Option<u32>,
    pub source_ip:     Option<IpAddr>,
    pub duration_us:   u64,
    pub old_value_hash: Option<[u8; 32]>,   // SHA-256 of OBE bytes pre-write
    pub new_value_hash: Option<[u8; 32]>,
    pub prev_record_hmac: [u8; 32],          // chained HMAC
    pub this_record_hmac: [u8; 32],
}
```

`this_record_hmac = HMAC_SHA256(K_audit, prev_record_hmac || record_bytes_minus_hmac)`.

### 8.2 Tamper evidence

Any modification to an old record breaks the HMAC chain. A periodic
**anchor** (every 1 hour) writes the current HMAC chain head to the
file header (extension TLV `0x0A`), so even a complete log truncation
is detectable.

### 8.3 Retention

Default 90 days. Records older than retention are exported to a
compressed `.audit.zst` file (file path configured via
`pragma audit_archive_path`) and pruned from the live log.

### 8.4 OCSF schema mapping

For SIEM integration, audit records map to the OCSF (Open Cybersecurity
Schema Framework) Authentication / Database Activity classes. The
mapping is documented in `[[FILE-12]]` §6 (observability).

### 8.5 Field redaction

Sensitive fields (defined per-collection by `redactedFields: [...]`)
are never written to the audit log — only their hashes. Configurable
via:

```js
db.users.setAuditRedaction({redactedFields: ["password_hash", "ssn"]});
```

---

## 9. Query Injection Protection

### 9.1 Parameterized only

User input must enter queries via parameters (`$1`, `$2`, …). The
engine **rejects** queries that interpolate user-controlled strings
(detected by AST containing user-source spans).

```js
// Wrong:
db.users.find(`{ name: "${userInput}" }`)
// Right:
db.users.find({ name: "$1" }, [userInput])
```

### 9.2 Input sanitization

Unicode normalization (NFC), strip null bytes (0x00), strip ASCII
control characters (0x01-0x1F except tab/newline/CR) at the edge.

### 9.3 Depth and size limits

```
pragma max_query_depth      = 32       (nested AND/OR depth)
pragma max_query_predicates = 1024     (total predicate count)
pragma max_query_size_bytes = 1048576  (1 MiB serialized query)
```

These prevent algorithmic-complexity DoS (regex bombs, deeply nested
predicates).

---

## 10. Rate Limiting

### 10.1 Token bucket per API key / IP

```rust
pub struct TokenBucket {
    pub capacity: u32,
    pub refill_rate_per_s: u32,
    pub tokens: AtomicU32,
    pub last_refill: AtomicU64,
}
```

Configured via:

```
pragma rate_limit_default = "1000/s burst 2000"     # global per-key default
pragma rate_limit_role:readonly = "5000/s burst 5000"
pragma rate_limit_role:admin    = "100000/s"
```

### 10.2 Penalty box

After N (default 10) consecutive auth failures from the same IP, the IP
enters a temporary ban list (15 minutes). Returns HTTP 429 with
`Retry-After`.

### 10.3 Cost-based limits

For expensive queries (FTS, aggregations), the engine maintains a
"complexity budget" per session: complex queries cost more tokens than
simple ones. Cost = estimated rows / 1000.

---

## 11. Secure Delete

### 11.1 Strategy

Two-mode policy:

- **DOD 5220.22-M (default for HDDs):** 3-pass overwrite — `0x00`,
  `0xFF`, random — before returning the page to the freelist.
- **Crypto-erase (default for SSDs):** retire the encryption key
  associated with the deleted data; the on-disk ciphertext becomes
  permanently unreadable.

Auto-detection: the engine identifies SSDs via OS-specific calls
(`/sys/block/.../queue/rotational` on Linux, `IOCTL_STORAGE_QUERY_PROPERTY`
on Windows) and chooses crypto-erase.

### 11.2 TRIM

After secure delete, the engine issues a `BLKDISCARD`/`UNMAP` for the
freed page extent (Linux: `fallocate(FALLOC_FL_PUNCH_HOLE)`; Windows:
`FSCTL_SET_ZERO_DATA`).

### 11.3 Granularity

Configured per collection via `pragma secure_delete_collections =
"users,billing"`. Other collections use ordinary delete (faster).

---

## 12. Integrity Verification

### 12.1 Per-page CRC (already in §4 of [[FILE-01]])

Verified on every page read; mismatch returns `OvnError::Corruption`.

### 12.2 Merkle tree

A Merkle tree over the SHA-256 of every page is maintained. Root hash
recorded at every checkpoint. The CLI command:

```
db.integrity_check([{full: true} | {sample: 0.05}])
```

verifies the entire tree (full) or a 5% sampled subset. Discovers
silent corruption that CRC missed (e.g. cosmic-ray-flipped CRC bytes).

### 12.3 PRAGMA integrity_check

A SQLite-style command that walks every B+ Tree, validates invariants
(parent-child key ordering, sibling links, fill ratios), checks
referential integrity (every index entry resolves to a doc), and
reports findings.

---

## 13. Tradeoffs and Alternatives Considered

| Choice                  | Picked            | Considered             | Why we picked     |
|-------------------------|-------------------|------------------------|-------------------|
| Cipher                  | AES-GCM-SIV       | AES-GCM, ChaCha-Poly   | Misuse-resistant; HW. |
| Password hash           | Argon2id          | bcrypt, scrypt, PBKDF2 | Memory-hard.      |
| KDF for sub-keys        | HKDF-SHA256       | HKDF-SHA512, raw HMAC  | Standardized; per-purpose. |
| FLE deterministic       | optional          | always random          | Indexing requires DET. |
| RBAC schema             | role + ABAC       | ACL-only               | Scales to many users. |
| Audit chain             | HMAC + anchor     | append-only file       | Tamper detection. |
| Rate limit              | token bucket      | leaky bucket           | Simpler bursting. |
| Secure delete           | mode auto         | always overwrite       | SSD wear concern. |

---

## 14. Open Questions

1. **Hardware Security Module (HSM).** PKCS#11 provider for KMS would
   let us never see master key bytes. v1.1 stretch.
2. **Searchable encryption side channels.** Equality-only DET leaks
   frequency. Document leakage profile in security guide before
   shipping range/substring SE.
3. **Audit log archive integrity.** Once archived, append-only chain
   is broken; we need a per-archive Merkle root signed by the engine
   key.

---

## 15. Compatibility Notes

- Existing v0.3 (unencrypted) databases can be encrypted in place via
  `db.enable_encryption(passphrase)` — performs a full rewrite.
- Decrypting an encrypted database requires a full rewrite (not just
  flipping a flag).
- FLE-encrypted documents can be decrypted only by clients with the
  appropriate field key derivation context.

---

## 16. Cross-References

- Page format and per-page encryption: `[[FILE-01]]` §11, §3.2 (header).
- WAL encryption: `[[FILE-02]]` §12.
- OBE encrypted envelope: `[[FILE-03]]` §5.8.
- API auth: `[[FILE-13]]` §6.
- Plugin sandbox isolation: `[[FILE-14]]` §4.
- Encryption ADR: `[[FILE-20]]`/003.

---

*End of `07-SECURITY-LAYER.md` — 593 lines.*
