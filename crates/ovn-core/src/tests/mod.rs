//! QA & regression test suite for ovn-core.
//!
//! Run with: `cargo test --features "test-utils"`
//! Each sub-module targets a specific bug or property.

pub mod integration;
pub mod qa;
pub mod regression;
