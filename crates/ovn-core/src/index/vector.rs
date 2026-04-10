//! Vector Search Index (HNSW / Exact).
//!
//! Provides vector index using Cosine Similarity for `$nearVector`.

use crate::error::OvnResult;

/// A vector embedding representation.
#[derive(Debug, Clone)]
pub struct VectorEmbedding {
    pub dimensions: usize,
    pub values: Vec<f32>,
}

impl VectorEmbedding {
    pub fn new(values: Vec<f32>) -> Self {
        Self {
            dimensions: values.len(),
            values,
        }
    }

    /// Compute Cosine Similarity between this vector and another.
    pub fn cosine_similarity(&self, other: &VectorEmbedding) -> f32 {
        if self.dimensions != other.dimensions || self.dimensions == 0 {
            return -1.0; // Incompatible or empty vectors
        }

        let mut dot_product = 0.0;
        let mut norm_a = 0.0;
        let mut norm_b = 0.0;

        for (a, b) in self.values.iter().zip(other.values.iter()) {
            dot_product += a * b;
            norm_a += a * a;
            norm_b += b * b;
        }

        if norm_a == 0.0 || norm_b == 0.0 {
            return 0.0;
        }

        dot_product / (norm_a.sqrt() * norm_b.sqrt())
    }
}

/// A naive/exact vector index supporting nearest neighbor (ANN) searches.
pub struct HnswVectorIndex {
    pub field: String,
    vectors: Vec<([u8; 16], VectorEmbedding)>,
}

impl HnswVectorIndex {
    /// Initialize a new vector index.
    pub fn new(field: String) -> Self {
        Self {
            field,
            vectors: Vec::new(),
        }
    }

    /// Insert a vector into the index.
    pub fn insert_vector(&mut self, doc_id: &[u8; 16], vector: VectorEmbedding) -> OvnResult<()> {
        self.vectors.push((*doc_id, vector));
        Ok(())
    }

    /// Search for the exact nearest neighbors using cosine similarity.
    pub fn search(&self, query: &VectorEmbedding, limit: usize) -> Vec<([u8; 16], f32)> {
        let mut results: Vec<([u8; 16], f32)> = self
            .vectors
            .iter()
            .map(|(id, vec)| (*id, query.cosine_similarity(vec)))
            .collect();

        // Sort by similarity descending (highest similarity first)
        results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        results.into_iter().take(limit).collect()
    }
}
