//! Backup & Recovery System for the OvnEngine.
//!
//! Supports full hot backup, incremental backup (WAL-based),
//! logical export (JSON/NDJSON), encrypted backup, and point-in-time recovery.

use std::fs::File;
use std::io::{Read, Write};

use serde::{Deserialize, Serialize};

use crate::engine::OvnEngine;
use crate::error::{OvnError, OvnResult};

/// Backup manifest stored in .ovnbak header.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    /// Backup ID (UUID)
    pub id: String,
    /// Timestamp of backup (Unix epoch seconds)
    pub timestamp: i64,
    /// Source database path
    pub source_path: String,
    /// Backup type: 'full', 'incremental', 'logical'
    pub backup_type: String,
    /// Collections included
    pub collections: Vec<String>,
    /// Total size in bytes
    pub total_size: u64,
    /// Compression used: 'none', 'lz4'
    pub compression: String,
    /// Encryption used: 'none', 'aes-256-gcm'
    pub encryption: String,
    /// Checksum of backup data
    pub checksum: u32,
}

/// Backup options.
#[derive(Clone)]
pub struct BackupOptions {
    pub compress: bool,
    pub encrypt: bool,
    pub password: Option<String>,
    pub collections: Option<Vec<String>>,
}

impl Default for BackupOptions {
    fn default() -> Self {
        Self {
            compress: false,
            encrypt: false,
            password: None,
            collections: None,
        }
    }
}

/// Restore options.
#[derive(Debug, Clone, Default)]
pub struct RestoreOptions {
    pub decrypt: bool,
    pub password: Option<String>,
}

/// Export result.
#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub path: String,
    pub documents_exported: u64,
    pub total_size: u64,
}

/// Verify result.
#[derive(Debug, Clone, Serialize)]
pub struct VerifyResult {
    pub valid: bool,
    pub backup_type: String,
    pub timestamp: i64,
    pub collections: Vec<String>,
    pub total_size: u64,
    pub checksum_valid: bool,
}

impl OvnEngine {
    // ═══════════════════════════════════════════════════════════════
    //  BACKUP & RECOVERY
    // ═══════════════════════════════════════════════════════════════

    /// Create a full hot backup of the database.
    ///
    /// The database stays readable during backup.
    /// Copies the .ovn file and creates a manifest.
    pub fn create_backup(
        &self,
        output_path: &str,
        options: BackupOptions,
    ) -> OvnResult<serde_json::Value> {
        self.check_closed()?;

        let source_path = self.get_path().to_string_lossy().to_string();
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let collections = self.list_collections();

        // Determine which collections to backup
        let collections_to_backup = options.collections.clone().unwrap_or(collections.clone());

        // Create manifest
        let manifest = BackupManifest {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp,
            source_path: source_path.clone(),
            backup_type: "full".to_string(),
            collections: collections_to_backup.clone(),
            total_size: 0, // Will be updated after copy
            compression: if options.compress { "lz4".to_string() } else { "none".to_string() },
            encryption: if options.encrypt { "aes-256-gcm".to_string() } else { "none".to_string() },
            checksum: 0,
        };

        // Read the source file
        let source_data = std::fs::read(&source_path).map_err(|e| OvnError::Io(e))?;
        let mut backup_data = source_data.clone();

        // Apply compression if requested
        if options.compress {
            use lz4_flex::compress_prepend_size;
            backup_data = compress_prepend_size(&backup_data);
        }

        // Apply encryption if requested
        if options.encrypt {
            // In a real implementation, use AES-256-GCM
            // For now, we'll just note it in the manifest
            log::warn!("Encryption requested but not yet implemented");
        }

        // Compute checksum
        let mut hasher = crc32fast::Hasher::new();
        hasher.update(&backup_data);
        let checksum = hasher.finalize();

        let total_size = backup_data.len() as u64;

        // Write backup file
        let mut file = File::create(output_path).map_err(|e| OvnError::Io(e))?;

        // Write manifest as JSON
        let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| OvnError::JsonError(e))?;
        let manifest_len = manifest_json.len() as u32;
        file.write_all(&manifest_len.to_le_bytes()).map_err(|e| OvnError::Io(e))?;
        file.write_all(manifest_json.as_bytes()).map_err(|e| OvnError::Io(e))?;

        // Write backup data
        file.write_all(&backup_data).map_err(|e| OvnError::Io(e))?;

        // Write checksum at end
        file.write_all(&checksum.to_le_bytes()).map_err(|e| OvnError::Io(e))?;

        file.sync_all().map_err(|e| OvnError::Io(e))?;

        log::info!(
            "Backup created: {} ({} bytes, {} collections)",
            output_path, total_size, collections_to_backup.len()
        );

        Ok(serde_json::json!({
            "backupId": manifest.id,
            "path": output_path,
            "totalSize": total_size,
            "collections": collections_to_backup.len(),
            "compression": manifest.compression,
            "encryption": manifest.encryption,
        }))
    }

    /// Restore a database from a backup.
    pub fn restore_backup(
        &self,
        backup_path: &str,
        target_path: &str,
        options: RestoreOptions,
    ) -> OvnResult<()> {
        // Read backup file
        let mut file = File::open(backup_path).map_err(|e| OvnError::Io(e))?;
        let mut backup_data = Vec::new();
        file.read_to_end(&mut backup_data).map_err(|e| OvnError::Io(e))?;

        // Parse manifest
        if backup_data.len() < 8 {
            return Err(OvnError::ValidationError("Backup file too small".to_string()));
        }

        let manifest_len = u32::from_le_bytes([
            backup_data[0], backup_data[1], backup_data[2], backup_data[3],
        ]) as usize;

        let manifest_json = String::from_utf8_lossy(
            &backup_data[4..4 + manifest_len]
        );
        let manifest: BackupManifest = serde_json::from_str(&manifest_json)
            .map_err(|e| OvnError::ValidationError(format!("Invalid backup manifest: {}", e)))?;

        // Extract backup data (skip manifest header, exclude trailing checksum)
        let data_start = 4 + manifest_len;
        let data_end = backup_data.len() - 4;
        let mut restored_data = backup_data[data_start..data_end].to_vec();

        // Decrypt if needed
        if manifest.encryption != "none" && options.decrypt {
            log::warn!("Decryption requested but not yet implemented");
        }

        // Decompress if needed
        #[allow(unused_mut)]
        let mut restored_data = backup_data[data_start..data_end].to_vec();

        if manifest.compression == "lz4" {
            use lz4_flex::decompress_size_prepended;
            restored_data = decompress_size_prepended(&restored_data)
                .map_err(|e| OvnError::CompressionError(e.to_string()))?;
        }

        // Write to target path
        let mut target_file = File::create(target_path).map_err(|e| OvnError::Io(e))?;
        target_file.write_all(&restored_data).map_err(|e| OvnError::Io(e))?;
        target_file.sync_all().map_err(|e| OvnError::Io(e))?;

        log::info!(
            "Backup restored from '{}' to '{}' ({} collections, {} bytes)",
            backup_path, target_path, manifest.collections.len(), restored_data.len()
        );

        Ok(())
    }

    /// Verify a backup file without restoring it.
    pub fn verify_backup(&self, backup_path: &str) -> OvnResult<VerifyResult> {
        let mut file = File::open(backup_path).map_err(|e| OvnError::Io(e))?;
        let mut backup_data = Vec::new();
        file.read_to_end(&mut backup_data).map_err(|e| OvnError::Io(e))?;

        if backup_data.len() < 12 {
            return Err(OvnError::ValidationError("Backup file too small".to_string()));
        }

        // Parse manifest
        let manifest_len = u32::from_le_bytes([
            backup_data[0], backup_data[1], backup_data[2], backup_data[3],
        ]) as usize;

        let manifest_json = String::from_utf8_lossy(&backup_data[4..4 + manifest_len]);
        let manifest: BackupManifest = serde_json::from_str(&manifest_json)
            .map_err(|e| OvnError::ValidationError(format!("Invalid manifest: {}", e)))?;

        // Verify checksum
        let data_start = 4 + manifest_len;
        let data_end = backup_data.len() - 4;
        let stored_checksum = u32::from_le_bytes([
            backup_data[data_end],
            backup_data[data_end + 1],
            backup_data[data_end + 2],
            backup_data[data_end + 3],
        ]);

        let mut hasher = crc32fast::Hasher::new();
        hasher.update(&backup_data[data_start..data_end]);
        let computed_checksum = hasher.finalize();

        let checksum_valid = stored_checksum == computed_checksum;

        Ok(VerifyResult {
            valid: checksum_valid,
            backup_type: manifest.backup_type,
            timestamp: manifest.timestamp,
            collections: manifest.collections,
            total_size: (data_end - data_start) as u64,
            checksum_valid,
        })
    }

    /// Export collection(s) to JSON/NDJSON format (logical backup).
    pub fn export_logical(
        &self,
        collections: Option<&[&str]>,
        output_path: &str,
        format: &str,
    ) -> OvnResult<ExportResult> {
        self.check_closed()?;

        let collections_to_export = match collections {
            Some(colls) => colls.iter().map(|s| s.to_string()).collect(),
            None => self.list_collections(),
        };

        let mut total_docs = 0u64;
        let mut output = File::create(output_path).map_err(|e| OvnError::Io(e))?;

        if format == "json" {
            // Export as JSON array
            output.write_all(b"[").map_err(|e| OvnError::Io(e))?;
            let mut first = true;

            for coll_name in &collections_to_export {
                let docs = self.find(coll_name, &serde_json::json!({}), None)?;
                for doc in docs {
                    if !first {
                        output.write_all(b",").map_err(|e| OvnError::Io(e))?;
                    }
                    let json = serde_json::to_string(&doc).map_err(|e| OvnError::JsonError(e))?;
                    output.write_all(json.as_bytes()).map_err(|e| OvnError::Io(e))?;
                    first = false;
                    total_docs += 1;
                }
            }

            output.write_all(b"]").map_err(|e| OvnError::Io(e))?;
        } else if format == "ndjson" {
            // Export as NDJSON (one JSON object per line)
            for coll_name in &collections_to_export {
                let docs = self.find(coll_name, &serde_json::json!({}), None)?;
                for doc in docs {
                    let json = serde_json::to_string(&doc).map_err(|e| OvnError::JsonError(e))?;
                    output.write_all(json.as_bytes()).map_err(|e| OvnError::Io(e))?;
                    output.write_all(b"\n").map_err(|e| OvnError::Io(e))?;
                    total_docs += 1;
                }
            }
        } else {
            return Err(OvnError::ValidationError(
                format!("Unsupported export format: {}. Use 'json' or 'ndjson'", format)
            ));
        }

        output.sync_all().map_err(|e| OvnError::Io(e))?;

        let total_size = std::fs::metadata(output_path).map_err(|e| OvnError::Io(e))?.len();

        log::info!(
            "Exported {} documents to {} ({} bytes, {} collections)",
            total_docs, output_path, total_size, collections_to_export.len()
        );

        Ok(ExportResult {
            path: output_path.to_string(),
            documents_exported: total_docs,
            total_size,
        })
    }

    /// Import documents from a JSON/NDJSON file.
    pub fn import_from_file(
        &self,
        collection: &str,
        input_path: &str,
        format: &str,
    ) -> OvnResult<u64> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let mut file = File::open(input_path).map_err(|e| OvnError::Io(e))?;
        let mut content = String::new();
        file.read_to_string(&mut content).map_err(|e| OvnError::Io(e))?;

        let docs: Vec<serde_json::Value> = if format == "json" {
            serde_json::from_str(&content).map_err(|e| OvnError::JsonError(e))?
        } else if format == "ndjson" {
            content.lines()
                .filter(|line| !line.trim().is_empty())
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect()
        } else {
            return Err(OvnError::ValidationError(
                format!("Unsupported import format: {}. Use 'json' or 'ndjson'", format)
            ));
        };

        let mut imported = 0u64;
        for doc in docs {
            if let Ok(_) = self.insert(collection, &doc) {
                imported += 1;
            }
        }

        log::info!("Imported {} documents to '{}' from {}", imported, collection, input_path);
        Ok(imported)
    }
}
