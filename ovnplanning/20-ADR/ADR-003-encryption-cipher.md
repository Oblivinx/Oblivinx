# ADR-003 — AES-256-GCM-SIV for Page Encryption

**Status:** Accepted, 2026-04
**Owners:** Security subsystem
**Cross refs:** `[[FILE-07]]`, `[[FILE-09]]`

---

## Context

At-rest encryption of `.ovn2` pages must:

1. Prevent passive disclosure (lost laptop, stolen disk image).
2. Detect tampering (auth tag).
3. Tolerate **nonce reuse** without catastrophic failure (engine writes pages by id; if nonce derivation has a bug, plain GCM leaks key bits).
4. Stay performant (≤ 3 µs per 8 KiB page on Skylake).
5. Integrate with HKDF sub-key derivation, key rotation, and FLE.

Candidates:

* **AES-256-GCM** — fastest with AES-NI; *catastrophic* on nonce reuse.
* **AES-256-GCM-SIV** (RFC 8452) — nonce-misuse-resistant; ~10–15% slower; auth + confidentiality.
* **ChaCha20-Poly1305** — better on CPUs without AES-NI (rare today); same nonce sensitivity as plain GCM.
* **XChaCha20-Poly1305** — large nonce, easier to randomize; slightly slower, less hardware acceleration.

## Decision

Use **AES-256-GCM-SIV** as the primary at-rest cipher for pages, WAL records (encrypted form), and session-encrypted oplog batches. Fall back to **ChaCha20-Poly1305** (specifically configurable via `EngineOptions::cipher`) when host CPU lacks AES-NI, with a clear warning emitted at engine open.

Sub-keys derived via HKDF-SHA-256:
```
K_data    = HKDF(K_master, "ovn:data:v1")
K_wal     = HKDF(K_master, "ovn:wal:v1")
K_index   = HKDF(K_master, "ovn:index:v1")
K_audit   = HKDF(K_master, "ovn:audit:v1")
K_field_X = HKDF(K_master, "ovn:fle:v1" || field_name)
```

Master key derived from passphrase via Argon2id (m=65536, t=3, p=4) or supplied by KMS.

## Consequences

**Positive**

* Nonce-reuse resistance protects against bugs that would otherwise leak the encryption key.
* Per-purpose sub-keys mean rotating one (e.g., audit) doesn't force re-encrypting everything.
* Standardized choice — passes most compliance audits without bespoke justification.

**Negative**

* ~10–15% slower than plain GCM; mitigated by AES-NI being universal on x86_64 / aarch64.
* Slightly larger ecosystem effort (some hardware enclaves only support GCM directly).

## Alternatives considered

* **AES-GCM** — rejected: nonce reuse is too sharp a knife.
* **ChaCha20-Poly1305 only** — rejected: AES-NI advantage too valuable on modern hardware.
* **AES-XTS** (used by FDE) — rejected: lacks authentication; we need AEAD.

## Open questions

* Hardware key wrap (TPM, Secure Enclave) for `K_master` storage — likely v0.8+.
* Post-quantum key wrap for KMS interactions — v1.x candidate.

*End of ADR-003.*
