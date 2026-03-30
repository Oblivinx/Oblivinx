//! I/O abstraction layer.
//!
//! Provides a [`FileBackend`] trait that abstracts filesystem operations,
//! enabling the storage engine to work with regular files, memory-mapped files,
//! or WASM filesystem shims.

pub mod backend;

pub use backend::{FileBackend, OsFileBackend};
