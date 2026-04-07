//! Background Worker Thread Pool.
//!
//! Provides a centralized registry and lifecycle management for all background
//! maintenance tasks: Compaction, GC (MVCC version pruning), TTL expiration,
//! Checkpoint, and BufferPool eviction.

pub mod workers;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// Configuration for a background worker.
#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub name: String,
    pub interval: Duration,
    pub enabled: bool,
}

/// A managed background worker handle.
struct WorkerHandle {
    name: String,
    handle: Option<JoinHandle<()>>,
    shutdown: Arc<AtomicBool>,
}

/// Central registry and lifecycle manager for all background workers.
pub struct BackgroundPool {
    workers: Vec<WorkerHandle>,
    global_shutdown: Arc<AtomicBool>,
}

impl Default for BackgroundPool {
    fn default() -> Self {
        Self::new()
    }
}

impl BackgroundPool {
    pub fn new() -> Self {
        Self {
            workers: Vec::new(),
            global_shutdown: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Spawn a new background worker with the given task closure.
    pub fn spawn<F>(&mut self, config: WorkerConfig, task: F)
    where
        F: Fn() + Send + 'static,
    {
        if !config.enabled {
            return;
        }

        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_clone = shutdown.clone();
        let interval = config.interval;
        let name = config.name.clone();

        let handle = thread::Builder::new()
            .name(format!("ovn-bg-{}", &name))
            .spawn(move || {
                while !shutdown_clone.load(Ordering::Relaxed) {
                    task();
                    thread::sleep(interval);
                }
            })
            .expect("Failed to spawn background worker thread");

        self.workers.push(WorkerHandle {
            name,
            handle: Some(handle),
            shutdown,
        });
    }

    /// Gracefully shut down all background workers.
    pub fn shutdown(&mut self) {
        self.global_shutdown.store(true, Ordering::SeqCst);

        for worker in &self.workers {
            worker.shutdown.store(true, Ordering::SeqCst);
        }

        for worker in &mut self.workers {
            if let Some(handle) = worker.handle.take() {
                let _ = handle.join();
            }
        }

        self.workers.clear();
    }

    /// Number of active workers.
    pub fn active_count(&self) -> usize {
        self.workers.len()
    }

    /// List names of all registered workers.
    pub fn worker_names(&self) -> Vec<&str> {
        self.workers.iter().map(|w| w.name.as_str()).collect()
    }
}

impl Drop for BackgroundPool {
    fn drop(&mut self) {
        self.shutdown();
    }
}
