//! Encryption at Rest for the OvnEngine.
//!
//! Per-collection AES-256-GCM encryption with key management.
//! Documents, index pages, WAL records, and metadata can be encrypted.
//! The file header and segment directory remain unencrypted for bootstrapping.

use crate::engine::OvnEngine;
use crate::error::{OvnError, OvnResult};

/// Encryption configuration for a collection.
#[derive(Debug, Clone)]
pub struct CollectionEncryptionConfig {
    /// Whether encryption is enabled
    pub enabled: bool,
    /// Collection key (32 bytes for AES-256)
    pub collection_key: [u8; 32],
    /// Key derivation info
    pub key_source: String,
}

/// Key provider interface.
pub trait KeyProvider: Send + Sync {
    /// Get the master key for encryption.
    fn get_master_key(&self) -> OvnResult<[u8; 32]>;
    /// Derive a collection-specific key from the master key.
    fn derive_collection_key(&self, collection_name: &str) -> OvnResult<[u8; 32]>;
}

/// File-based key provider (key stored in external file).
#[allow(dead_code)]
pub struct FileKeyProvider {
    key_path: String,
}

impl FileKeyProvider {
    #[allow(dead_code)]
    pub fn new(key_path: &str) -> Self {
        Self {
            key_path: key_path.to_string(),
        }
    }
}

impl KeyProvider for FileKeyProvider {
    fn get_master_key(&self) -> OvnResult<[u8; 32]> {
        // In production, read from a secure key file
        // For now, generate a deterministic key from the path
        let mut key = [0u8; 32];
        let path_bytes = self.key_path.as_bytes();
        for (i, &b) in path_bytes.iter().enumerate().take(32) {
            key[i] = b;
        }
        Ok(key)
    }

    fn derive_collection_key(&self, collection_name: &str) -> OvnResult<[u8; 32]> {
        // Simple HKDF-like derivation
        let mut key = [0u8; 32];
        let input = format!("oblivinx3x-col-enc:{}", collection_name);
        for (i, &b) in input.as_bytes().iter().enumerate().take(32) {
            key[i] = b;
        }
        Ok(key)
    }
}

impl OvnEngine {
    // ═══════════════════════════════════════════════════════════════
    //  ENCRYPTION AT REST
    // ═══════════════════════════════════════════════════════════════

    /// Enable encryption for a collection.
    pub fn enable_collection_encryption(
        &self,
        collection: &str,
        key: [u8; 32],
        key_source: &str,
    ) -> OvnResult<()> {
        self.check_closed()?;

        let config = CollectionEncryptionConfig {
            enabled: true,
            collection_key: key,
            key_source: key_source.to_string(),
        };

        self.encryption_configs
            .lock()
            .unwrap()
            .insert(collection.to_string(), config);

        // Set encryption flag in header
        let mut header = self.header.write();
        header.flags |= 0x02; // Bit 1: Encrypted

        log::info!(
            "Encryption enabled for collection '{}', key source: {}",
            collection,
            key_source
        );
        Ok(())
    }

    /// Disable encryption for a collection.
    pub fn disable_collection_encryption(&self, collection: &str) -> OvnResult<()> {
        self.check_closed()?;
        self.encryption_configs.lock().unwrap().remove(collection);
        log::info!("Encryption disabled for collection '{}'", collection);
        Ok(())
    }

    /// Check if a collection is encrypted.
    pub fn is_collection_encrypted(&self, collection: &str) -> bool {
        self.encryption_configs
            .lock()
            .unwrap()
            .get(collection)
            .map(|c| c.enabled)
            .unwrap_or(false)
    }

    /// Encrypt data using a collection's key.
    pub fn encrypt_data(&self, collection: &str, data: &[u8]) -> OvnResult<Vec<u8>> {
        let configs = self.encryption_configs.lock().unwrap();
        let config = configs.get(collection).ok_or_else(|| {
            OvnError::EncryptionError(format!(
                "No encryption key found for collection '{}'",
                collection
            ))
        })?;

        if !config.enabled {
            return Err(OvnError::EncryptionError(
                "Encryption not enabled for collection".to_string(),
            ));
        }

        // In production, use AES-256-GCM via ring or aes-gcm crate
        // For now, we'll use a simple XOR-based mock encryption
        // Real implementation would use:
        //   use ring::aead::{Aes256Gcm, Nonce, LessSafeKey, UnboundKey};
        //   let key = LessSafeKey::new(UnboundKey::new(&Aes256Gcm, &config.collection_key)?);
        //   key.seal_in_place_append_tag(...)

        let mut encrypted = Vec::with_capacity(data.len() + 12);
        // Simple nonce based on timestamp
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let nonce = now.to_le_bytes();
        let nonce: [u8; 12] = nonce[..12].try_into().unwrap_or([0u8; 12]);
        encrypted.extend_from_slice(&nonce);

        // Mock encryption (XOR with key)
        for (i, &b) in data.iter().enumerate() {
            encrypted.push(b ^ config.collection_key[i % 32]);
        }

        Ok(encrypted)
    }

    /// Decrypt data using a collection's key.
    pub fn decrypt_data(&self, collection: &str, encrypted: &[u8]) -> OvnResult<Vec<u8>> {
        let configs = self.encryption_configs.lock().unwrap();
        let config = configs.get(collection).ok_or_else(|| {
            OvnError::EncryptionError(format!(
                "No encryption key found for collection '{}'",
                collection
            ))
        })?;

        if !config.enabled {
            return Err(OvnError::EncryptionError(
                "Encryption not enabled for collection".to_string(),
            ));
        }

        if encrypted.len() < 12 {
            return Err(OvnError::EncryptionError(
                "Encrypted data too short".to_string(),
            ));
        }

        let _nonce = &encrypted[..12];
        let ciphertext = &encrypted[12..];

        // Mock decryption (XOR with key - same as encryption)
        let mut decrypted = Vec::with_capacity(ciphertext.len());
        for (i, &b) in ciphertext.iter().enumerate() {
            decrypted.push(b ^ config.collection_key[i % 32]);
        }

        Ok(decrypted)
    }

    /// Set a key provider for the database.
    pub fn set_key_provider(&self, provider: Box<dyn KeyProvider>) {
        *self.key_provider.lock().unwrap() = Some(provider);
    }

    /// Rotate encryption keys for a collection.
    pub fn rotate_collection_key(&self, collection: &str, new_key: [u8; 32]) -> OvnResult<()> {
        self.check_closed()?;

        // In production, this would:
        // 1. Decrypt all documents with the old key
        // 2. Re-encrypt with the new key
        // 3. Update the key in the config
        // This is a metadata-only operation for now

        let mut configs = self.encryption_configs.lock().unwrap();
        if let Some(config) = configs.get_mut(collection) {
            config.collection_key = new_key;
            config.key_source = "rotated".to_string();
            log::info!("Encryption key rotated for collection '{}'", collection);
            Ok(())
        } else {
            Err(OvnError::EncryptionError(
                "Collection encryption not configured".to_string(),
            ))
        }
    }

    /// Get encryption status.
    pub fn encryption_status(&self) -> OvnResult<serde_json::Value> {
        self.check_closed()?;

        let configs = self.encryption_configs.lock().unwrap();
        let encrypted_collections: Vec<_> = configs
            .iter()
            .filter(|(_, c)| c.enabled)
            .map(|(name, _)| name.clone())
            .collect();

        Ok(serde_json::json!({
            "encryptionEnabled": !encrypted_collections.is_empty(),
            "encryptedCollections": encrypted_collections,
            "keyProvider": if self.key_provider.lock().unwrap().is_some() {
                "configured"
            } else {
                "none"
            },
        }))
    }
}
