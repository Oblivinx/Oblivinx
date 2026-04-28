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

pub mod aggregation;
pub mod filter;
pub mod planner;
pub mod sql_parser;
pub mod update;

pub use aggregation::{execute_pipeline, AggregateStage};
pub use filter::{evaluate_filter, Filter, FilterOp};
pub use sql_parser::SqlQuery;
pub use update::{apply_update, UpdateOp};
