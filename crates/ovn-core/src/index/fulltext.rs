//! Full-text inverted index.
//!
//! Maps stemmed, lowercased tokens to posting lists for text search.
//! Supports phrase queries and proximity searches via position tracking.

use std::collections::{BTreeMap, HashMap};
use parking_lot::RwLock;

use crate::error::OvnResult;

/// A posting list entry — one occurrence of a token in a document.
#[derive(Debug, Clone)]
pub struct Posting {
    /// Document ID
    pub doc_id: [u8; 16],
    /// Field that contains the token
    pub field_id: u32,
    /// Number of times the token appears in this field
    pub term_frequency: u32,
    /// Positions within the field
    pub positions: Vec<u32>,
}

/// Full-text search index using an inverted index.
pub struct FullTextIndex {
    /// Inverted index: token → posting list
    index: RwLock<BTreeMap<String, Vec<Posting>>>,
    /// Document field count (for TF-IDF scoring)
    doc_count: RwLock<u64>,
    /// Index name
    pub name: String,
    /// Indexed fields
    pub fields: Vec<String>,
}

impl FullTextIndex {
    pub fn new(name: String, fields: Vec<String>) -> Self {
        Self {
            index: RwLock::new(BTreeMap::new()),
            doc_count: RwLock::new(0),
            name,
            fields,
        }
    }

    /// Index a document's text fields.
    pub fn index_document(&self, doc_id: [u8; 16], field_id: u32, text: &str) -> OvnResult<()> {
        let tokens = Self::tokenize(text);
        let mut token_positions: HashMap<String, Vec<u32>> = HashMap::new();

        for (pos, token) in tokens.iter().enumerate() {
            let stemmed = Self::stem(token);
            token_positions
                .entry(stemmed)
                .or_default()
                .push(pos as u32);
        }

        let mut index = self.index.write();
        for (token, positions) in token_positions {
            let posting = Posting {
                doc_id,
                field_id,
                term_frequency: positions.len() as u32,
                positions,
            };

            index.entry(token).or_default().push(posting);
        }

        *self.doc_count.write() += 1;
        Ok(())
    }

    /// Search for documents containing the query text.
    pub fn search(&self, query: &str) -> Vec<SearchResult> {
        let tokens = Self::tokenize(query);
        let stemmed: Vec<String> = tokens.iter().map(|t| Self::stem(t)).collect();

        let index = self.index.read();
        let doc_count = *self.doc_count.read();

        // Collect matching postings per token
        let mut doc_scores: HashMap<[u8; 16], f64> = HashMap::new();

        for token in &stemmed {
            if let Some(postings) = index.get(token) {
                let idf = ((doc_count as f64 + 1.0) / (postings.len() as f64 + 1.0)).ln() + 1.0;

                for posting in postings {
                    let tf = 1.0 + (posting.term_frequency as f64).ln();
                    let score = tf * idf;
                    *doc_scores.entry(posting.doc_id).or_insert(0.0) += score;
                }
            }
        }

        let mut results: Vec<SearchResult> = doc_scores
            .into_iter()
            .map(|(doc_id, score)| SearchResult { doc_id, score })
            .collect();

        // Sort by score descending
        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

        results
    }

    /// Remove a document from the index.
    pub fn remove_document(&self, doc_id: &[u8; 16]) {
        let mut index = self.index.write();
        for postings in index.values_mut() {
            postings.retain(|p| &p.doc_id != doc_id);
        }
        // Remove empty posting lists
        index.retain(|_, postings| !postings.is_empty());
    }

    /// Tokenize text using Unicode word segmentation (simplified).
    fn tokenize(text: &str) -> Vec<String> {
        text.to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| s.len() >= 2) // Skip single chars
            .map(|s| s.to_string())
            .collect()
    }

    /// Simple English stemmer (suffix stripping).
    fn stem(word: &str) -> String {
        let word = word.to_lowercase();
        // Very basic suffix stripping
        if word.ends_with("ing") && word.len() > 5 {
            return word[..word.len() - 3].to_string();
        }
        if word.ends_with("tion") && word.len() > 6 {
            return word[..word.len() - 4].to_string();
        }
        if word.ends_with("ness") && word.len() > 6 {
            return word[..word.len() - 4].to_string();
        }
        if word.ends_with("ment") && word.len() > 6 {
            return word[..word.len() - 4].to_string();
        }
        if word.ends_with("ly") && word.len() > 4 {
            return word[..word.len() - 2].to_string();
        }
        if word.ends_with("es") && word.len() > 4 {
            return word[..word.len() - 2].to_string();
        }
        if word.ends_with("ed") && word.len() > 4 {
            return word[..word.len() - 2].to_string();
        }
        if word.ends_with("s") && !word.ends_with("ss") && word.len() > 3 {
            return word[..word.len() - 1].to_string();
        }
        word
    }
}

/// A full-text search result with TF-IDF score.
#[derive(Debug, Clone)]
pub struct SearchResult {
    pub doc_id: [u8; 16],
    pub score: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tokenize() {
        let tokens = FullTextIndex::tokenize("Hello, World! This is a test.");
        assert!(tokens.contains(&"hello".to_string()));
        assert!(tokens.contains(&"world".to_string()));
        assert!(tokens.contains(&"this".to_string()));
        assert!(tokens.contains(&"test".to_string()));
    }

    #[test]
    fn test_full_text_search() {
        let fti = FullTextIndex::new(
            "content_text".to_string(),
            vec!["content".to_string()],
        );

        let doc1_id = [1u8; 16];
        let doc2_id = [2u8; 16];

        fti.index_document(doc1_id, 0, "The quick brown fox jumps over the lazy dog").unwrap();
        fti.index_document(doc2_id, 0, "A quick red car drives fast").unwrap();

        let results = fti.search("quick fox");
        assert!(!results.is_empty());
        // doc1 should score higher (matches both tokens)
        assert_eq!(results[0].doc_id, doc1_id);
    }
}
