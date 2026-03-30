//! File backend implementations.
//!
//! The [`FileBackend`] trait defines the I/O operations needed by the storage engine.
//! [`OsFileBackend`] is the standard implementation using `std::fs::File`.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::{OvnError, OvnResult};

/// Trait abstracting file I/O for the storage engine.
///
/// This allows swapping the file backend for testing, WASM environments,
/// or memory-mapped implementations.
pub trait FileBackend: Send + Sync {
    /// Read a page at the given page number.
    fn read_page(&self, page_number: u64, page_size: u32) -> OvnResult<Vec<u8>>;

    /// Write a page at the given page number.
    fn write_page(&self, page_number: u64, page_size: u32, data: &[u8]) -> OvnResult<()>;

    /// Append data to the end of the file, returning the offset written to.
    fn append(&self, data: &[u8]) -> OvnResult<u64>;

    /// Sync all buffered writes to disk (fsync).
    fn sync(&self) -> OvnResult<()>;

    /// Get the current file size in bytes.
    fn file_size(&self) -> OvnResult<u64>;

    /// Truncate the file to the given size.
    fn truncate(&self, size: u64) -> OvnResult<()>;

    /// Read raw bytes at a specific offset.
    fn read_at(&self, offset: u64, length: usize) -> OvnResult<Vec<u8>>;

    /// Write raw bytes at a specific offset.
    fn write_at(&self, offset: u64, data: &[u8]) -> OvnResult<()>;
}

/// Standard file backend using OS file operations.
pub struct OsFileBackend {
    file: Mutex<File>,
    path: PathBuf,
    read_only: bool,
}

impl OsFileBackend {
    /// Open or create a file at the given path.
    pub fn open(path: &Path, read_only: bool) -> OvnResult<Self> {
        let file = if read_only {
            OpenOptions::new().read(true).open(path)?
        } else {
            OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(path)?
        };

        Ok(Self {
            file: Mutex::new(file),
            path: path.to_path_buf(),
            read_only,
        })
    }

    /// Get the file path.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl FileBackend for OsFileBackend {
    fn read_page(&self, page_number: u64, page_size: u32) -> OvnResult<Vec<u8>> {
        let offset = page_number * page_size as u64;
        self.read_at(offset, page_size as usize)
    }

    fn write_page(&self, page_number: u64, page_size: u32, data: &[u8]) -> OvnResult<()> {
        if self.read_only {
            return Err(OvnError::ReadOnly);
        }
        let offset = page_number * page_size as u64;
        self.write_at(offset, data)
    }

    fn append(&self, data: &[u8]) -> OvnResult<u64> {
        if self.read_only {
            return Err(OvnError::ReadOnly);
        }
        let mut file = self.file.lock().unwrap();
        let offset = file.seek(SeekFrom::End(0))?;
        file.write_all(data)?;
        Ok(offset)
    }

    fn sync(&self) -> OvnResult<()> {
        let file = self.file.lock().unwrap();
        file.sync_all()?;
        Ok(())
    }

    fn file_size(&self) -> OvnResult<u64> {
        let file = self.file.lock().unwrap();
        Ok(file.metadata()?.len())
    }

    fn truncate(&self, size: u64) -> OvnResult<()> {
        if self.read_only {
            return Err(OvnError::ReadOnly);
        }
        let file = self.file.lock().unwrap();
        file.set_len(size)?;
        Ok(())
    }

    fn read_at(&self, offset: u64, length: usize) -> OvnResult<Vec<u8>> {
        let mut file = self.file.lock().unwrap();
        file.seek(SeekFrom::Start(offset))?;
        let mut buf = vec![0u8; length];
        file.read_exact(&mut buf)?;
        Ok(buf)
    }

    fn write_at(&self, offset: u64, data: &[u8]) -> OvnResult<()> {
        if self.read_only {
            return Err(OvnError::ReadOnly);
        }
        let mut file = self.file.lock().unwrap();
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(data)?;
        Ok(())
    }
}

/// In-memory file backend for testing.
#[cfg(test)]
pub struct MemoryBackend {
    data: Mutex<Vec<u8>>,
}

#[cfg(test)]
impl MemoryBackend {
    pub fn new() -> Self {
        Self {
            data: Mutex::new(Vec::new()),
        }
    }
}

#[cfg(test)]
impl FileBackend for MemoryBackend {
    fn read_page(&self, page_number: u64, page_size: u32) -> OvnResult<Vec<u8>> {
        let offset = (page_number * page_size as u64) as usize;
        let data = self.data.lock().unwrap();
        if offset + page_size as usize > data.len() {
            return Err(OvnError::Io(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "Read beyond end of memory backend",
            )));
        }
        Ok(data[offset..offset + page_size as usize].to_vec())
    }

    fn write_page(&self, page_number: u64, page_size: u32, page_data: &[u8]) -> OvnResult<()> {
        let offset = (page_number * page_size as u64) as usize;
        let mut data = self.data.lock().unwrap();
        if offset + page_data.len() > data.len() {
            data.resize(offset + page_data.len(), 0);
        }
        data[offset..offset + page_data.len()].copy_from_slice(page_data);
        Ok(())
    }

    fn append(&self, new_data: &[u8]) -> OvnResult<u64> {
        let mut data = self.data.lock().unwrap();
        let offset = data.len() as u64;
        data.extend_from_slice(new_data);
        Ok(offset)
    }

    fn sync(&self) -> OvnResult<()> {
        Ok(())
    }

    fn file_size(&self) -> OvnResult<u64> {
        Ok(self.data.lock().unwrap().len() as u64)
    }

    fn truncate(&self, size: u64) -> OvnResult<()> {
        self.data.lock().unwrap().truncate(size as usize);
        Ok(())
    }

    fn read_at(&self, offset: u64, length: usize) -> OvnResult<Vec<u8>> {
        let data = self.data.lock().unwrap();
        let start = offset as usize;
        if start + length > data.len() {
            return Err(OvnError::Io(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "Read beyond end of memory backend",
            )));
        }
        Ok(data[start..start + length].to_vec())
    }

    fn write_at(&self, offset: u64, new_data: &[u8]) -> OvnResult<()> {
        let mut data = self.data.lock().unwrap();
        let start = offset as usize;
        if start + new_data.len() > data.len() {
            data.resize(start + new_data.len(), 0);
        }
        data[start..start + new_data.len()].copy_from_slice(new_data);
        Ok(())
    }
}
