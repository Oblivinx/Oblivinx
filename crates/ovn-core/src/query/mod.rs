//! Query Engine — MQL-compatible parser, optimizer, and executor.
//!
//! Pipeline: Lexer → Parser → AST → Logical Plan → Physical Plan → Executor
//!
//! Supports MongoDB Query Language (MQL) subset:
//! - Comparison: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin
//! - Logical: $and, $or, $not, $nor
//! - Array: $all, $elemMatch, $size
//! - Element: $exists, $type
//! - Update: $set, $unset, $inc, $push, $pull, $addToSet, etc.
//! - Aggregation: $match, $group, $project, $sort, $limit, $skip, $unwind, $lookup

pub mod filter;
pub mod update;
pub mod aggregation;
pub mod planner;

pub use filter::{Filter, FilterOp, evaluate_filter};
pub use update::{UpdateOp, apply_update};
pub use aggregation::{AggregateStage, execute_pipeline};
