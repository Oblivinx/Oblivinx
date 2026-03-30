//! Placeholder benchmark for criterion.
//! Run with: cargo bench -p ovn-core

use criterion::{criterion_group, criterion_main, Criterion};

fn benchmark_placeholder(c: &mut Criterion) {
    c.bench_function("noop", |b| b.iter(|| {}));
}

criterion_group!(benches, benchmark_placeholder);
criterion_main!(benches);
