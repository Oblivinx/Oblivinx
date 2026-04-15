//! SQL-like Query Parser for the OvnEngine.
//!
//! Parses a subset of SQL syntax and compiles it to MQL filter/aggregation pipelines.
//! Supported: SELECT, WHERE, ORDER BY, LIMIT, SKIP, GROUP BY, INSERT, UPDATE, DELETE.

use serde::{Deserialize, Serialize};

use crate::engine::OvnEngine;
use crate::error::{OvnError, OvnResult};

/// Parsed SQL-like query.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlQuery {
    pub query_type: String,
    pub collection: Option<String>,
    pub fields: Vec<String>,
    pub filter: Option<serde_json::Value>,
    pub sort: Option<Vec<(String, i32)>>,
    pub limit: Option<usize>,
    pub skip: Option<usize>,
    pub group_by: Option<Vec<String>>,
    pub joins: Vec<SqlJoin>,
    pub insert_values: Option<Vec<serde_json::Value>>,
    pub update_set: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlJoin {
    pub collection: String,
    pub alias: String,
    pub local_field: String,
    pub foreign_field: String,
}

#[derive(Debug, Clone, PartialEq)]
enum SqlToken {
    Keyword(String),
    Identifier(String),
    Literal(serde_json::Value),
    Operator(String),
    Punctuation(char),
    Star,
}

struct SqlParser {
    tokens: Vec<SqlToken>,
    pos: usize,
}

impl SqlParser {
    fn new(input: &str) -> Self {
        Self {
            tokens: Self::tokenize(input),
            pos: 0,
        }
    }

    fn tokenize(input: &str) -> Vec<SqlToken> {
        let mut tokens = Vec::new();
        let mut chars = input.chars().peekable();
        while let Some(&ch) = chars.peek() {
            if ch.is_whitespace() { chars.next(); continue; }
            if ch == '*' { tokens.push(SqlToken::Star); chars.next(); }
            else if ch == ',' { tokens.push(SqlToken::Punctuation(',')); chars.next(); }
            else if ch == '(' { tokens.push(SqlToken::Punctuation('(')); chars.next(); }
            else if ch == ')' { tokens.push(SqlToken::Punctuation(')')); chars.next(); }
            else if ch == '=' || ch == '>' || ch == '<' || ch == '!' {
                let mut op = String::from(ch); chars.next();
                if chars.peek() == Some(&'=') { op.push('='); chars.next(); }
                tokens.push(SqlToken::Operator(op));
            }
            else if ch == '\'' || ch == '"' {
                let quote = ch; chars.next();
                let mut s = String::new();
                while let Some(&c) = chars.peek() {
                    if c == quote { chars.next(); break; }
                    s.push(c); chars.next();
                }
                tokens.push(SqlToken::Literal(serde_json::Value::String(s)));
            }
            else if ch.is_ascii_digit() || ch == '-' {
                let mut num = String::new();
                if ch == '-' { num.push(ch); chars.next(); }
                while let Some(&c) = chars.peek() {
                    if c.is_ascii_digit() || c == '.' { num.push(c); chars.next(); } else { break; }
                }
                if num.contains('.') {
                    if let Ok(f) = num.parse::<f64>() { tokens.push(SqlToken::Literal(serde_json::json!(f))); }
                } else if let Ok(n) = num.parse::<i64>() {
                    tokens.push(SqlToken::Literal(serde_json::json!(n)));
                }
            }
            else if ch.is_alphabetic() || ch == '_' {
                let mut word = String::new();
                while let Some(&c) = chars.peek() {
                    if c.is_alphanumeric() || c == '_' { word.push(c); chars.next(); } else { break; }
                }
                let upper = word.to_uppercase();
                if matches!(upper.as_str(), "SELECT"|"FROM"|"WHERE"|"ORDER"|"BY"|"LIMIT"|"SKIP"|"INSERT"|"INTO"|"VALUES"|"UPDATE"|"SET"|"DELETE"|"GROUP"|"JOIN"|"ON"|"AND"|"OR"|"NOT"|"IN"|"IS"|"NULL"|"ASC"|"DESC"|"AS") {
                    tokens.push(SqlToken::Keyword(upper));
                } else {
                    tokens.push(SqlToken::Identifier(word));
                }
            }
            else { chars.next(); }
        }
        tokens
    }

    fn peek(&self) -> Option<&SqlToken> { self.tokens.get(self.pos) }
    fn advance(&mut self) -> Option<SqlToken> {
        let t = self.tokens.get(self.pos).cloned();
        if t.is_some() { self.pos += 1; }
        t
    }
    fn expect_keyword(&mut self, kw: &str) -> OvnResult<()> {
        match self.peek() {
            Some(SqlToken::Keyword(k)) if k == kw => { self.advance(); Ok(()) }
            _ => Err(OvnError::QuerySyntaxError { position: self.pos, message: format!("Expected '{}'", kw) })
        }
    }

    fn parse(&mut self) -> OvnResult<SqlQuery> {
        match self.peek() {
            Some(SqlToken::Keyword(k)) if k == "SELECT" => self.parse_select(),
            Some(SqlToken::Keyword(k)) if k == "INSERT" => self.parse_insert(),
            Some(SqlToken::Keyword(k)) if k == "UPDATE" => self.parse_update(),
            Some(SqlToken::Keyword(k)) if k == "DELETE" => self.parse_delete(),
            _ => Err(OvnError::QuerySyntaxError { position: self.pos, message: "Expected SELECT, INSERT, UPDATE, or DELETE".to_string() })
        }
    }

    fn parse_select(&mut self) -> OvnResult<SqlQuery> {
        self.expect_keyword("SELECT")?;
        let mut fields = Vec::new();
        loop {
            match self.peek() {
                Some(SqlToken::Star) => { fields.push("*".to_string()); self.advance(); break; }
                Some(SqlToken::Identifier(n)) => { let name = n.clone(); fields.push(name); self.advance(); }
                _ => break,
            }
            if let Some(SqlToken::Punctuation(',')) = self.peek() { self.advance(); } else { break; }
        }
        self.expect_keyword("FROM")?;
        let collection = if let Some(SqlToken::Identifier(n)) = self.peek().cloned() { self.advance(); Some(n) } else { None };

        let mut joins = Vec::new();
        while let Some(SqlToken::Keyword(k)) = self.peek().cloned() {
            if k != "JOIN" { break; }
            self.advance();
            let join_coll = if let Some(SqlToken::Identifier(n)) = self.peek().cloned() { self.advance(); n } else { return Err(self.syntax_error("Expected collection after JOIN")); };
            let alias = if matches!(self.peek(), Some(SqlToken::Keyword(ref k)) if k == "AS") {
                self.advance();
                if let Some(SqlToken::Identifier(n)) = self.peek().cloned() { self.advance(); n } else { join_coll.clone() }
            } else { join_coll.clone() };
            self.expect_keyword("ON")?;
            let local_field = self.parse_field_ref()?;
            self.expect_operator("=")?;
            let foreign_field = self.parse_field_ref()?;
            joins.push(SqlJoin { collection: join_coll, alias, local_field, foreign_field });
        }

        let filter = if matches!(self.peek(), Some(SqlToken::Keyword(ref k)) if k == "WHERE") { self.advance(); Some(self.parse_where_clause()?) } else { None };

        let mut group_by = Vec::new();
        if matches!(self.peek(), Some(SqlToken::Keyword(ref k)) if k == "GROUP") {
            self.advance(); self.expect_keyword("BY")?;
            loop {
                if let Some(SqlToken::Identifier(n)) = self.peek().cloned() { group_by.push(n); self.advance(); }
                if let Some(SqlToken::Punctuation(',')) = self.peek() { self.advance(); } else { break; }
            }
        }

        let mut sort = Vec::new();
        if matches!(self.peek(), Some(SqlToken::Keyword(ref k)) if k == "ORDER") {
            self.advance(); self.expect_keyword("BY")?;
            loop {
                if let Some(SqlToken::Identifier(n)) = self.peek().cloned() {
                    let field = n.clone(); self.advance();
                    let dir = if matches!(self.peek(), Some(SqlToken::Keyword(ref k)) if k == "DESC") { self.advance(); -1 } else {
                        if matches!(self.peek(), Some(SqlToken::Keyword(ref k)) if k == "ASC") { self.advance(); }
                        1
                    };
                    sort.push((field, dir));
                }
                if let Some(SqlToken::Punctuation(',')) = self.peek() { self.advance(); } else { break; }
            }
        }

        let limit = if matches!(self.peek(), Some(SqlToken::Keyword(ref k)) if k == "LIMIT") {
            self.advance();
            if let Some(SqlToken::Literal(v)) = self.peek().cloned() { self.advance(); v.as_u64().map(|n| n as usize) } else { None }
        } else { None };

        let skip = if matches!(self.peek(), Some(SqlToken::Keyword(ref k)) if k == "SKIP") {
            self.advance();
            if let Some(SqlToken::Literal(v)) = self.peek().cloned() { self.advance(); v.as_u64().map(|n| n as usize) } else { None }
        } else { None };

        Ok(SqlQuery { query_type: "select".to_string(), collection, fields, filter, sort: if sort.is_empty() { None } else { Some(sort) }, limit, skip, group_by: if group_by.is_empty() { None } else { Some(group_by) }, joins, insert_values: None, update_set: None })
    }

    fn parse_insert(&mut self) -> OvnResult<SqlQuery> {
        self.expect_keyword("INSERT")?; self.expect_keyword("INTO")?;
        let collection = if let Some(SqlToken::Identifier(n)) = self.peek().cloned() { self.advance(); Some(n) } else { None };
        let mut field_list = Vec::new();
        if let Some(SqlToken::Punctuation('(')) = self.peek().cloned() {
            self.advance();
            loop {
                if let Some(SqlToken::Identifier(n)) = self.peek().cloned() { field_list.push(n); self.advance(); }
                if let Some(SqlToken::Punctuation(',')) = self.peek() { self.advance(); } else { break; }
            }
            self.expect_punctuation(')')?;
        }
        self.expect_keyword("VALUES")?;
        let mut values = Vec::new();
        if let Some(SqlToken::Punctuation('(')) = self.peek().cloned() {
            self.advance();
            let mut doc = serde_json::Map::new();
            let mut idx = 0;
            loop {
                if let Some(SqlToken::Literal(v)) = self.peek().cloned() {
                    self.advance();
                    let key = if idx < field_list.len() { field_list[idx].clone() } else { format!("field_{}", idx) };
                    doc.insert(key, v); idx += 1;
                }
                if let Some(SqlToken::Punctuation(',')) = self.peek() { self.advance(); } else { break; }
            }
            self.expect_punctuation(')')?;
            values.push(serde_json::Value::Object(doc));
        }
        Ok(SqlQuery { query_type: "insert".to_string(), collection, fields: Vec::new(), filter: None, sort: None, limit: None, skip: None, group_by: None, joins: Vec::new(), insert_values: Some(values), update_set: None })
    }

    fn parse_update(&mut self) -> OvnResult<SqlQuery> {
        self.expect_keyword("UPDATE")?;
        let collection = if let Some(SqlToken::Identifier(n)) = self.peek().cloned() { self.advance(); Some(n) } else { None };
        self.expect_keyword("SET")?;
        let mut set = serde_json::Map::new();
        loop {
            if let Some(SqlToken::Identifier(f)) = self.peek().cloned() {
                let field_name = f.clone(); self.advance();
                self.expect_operator("=")?;
                if let Some(SqlToken::Literal(v)) = self.peek().cloned() { self.advance(); set.insert(field_name, v); }
            }
            if let Some(SqlToken::Punctuation(',')) = self.peek() { self.advance(); } else { break; }
        }
        let filter = if matches!(self.peek(), Some(SqlToken::Keyword(ref k)) if k == "WHERE") { self.advance(); Some(self.parse_where_clause()?) } else { None };
        Ok(SqlQuery { query_type: "update".to_string(), collection, fields: Vec::new(), filter, sort: None, limit: None, skip: None, group_by: None, joins: Vec::new(), insert_values: None, update_set: Some(serde_json::Value::Object(set)) })
    }

    fn parse_delete(&mut self) -> OvnResult<SqlQuery> {
        self.expect_keyword("DELETE")?; self.expect_keyword("FROM")?;
        let collection = if let Some(SqlToken::Identifier(n)) = self.peek().cloned() { self.advance(); Some(n) } else { None };
        let filter = if matches!(self.peek(), Some(SqlToken::Keyword(ref k)) if k == "WHERE") { self.advance(); Some(self.parse_where_clause()?) } else { None };
        Ok(SqlQuery { query_type: "delete".to_string(), collection, fields: Vec::new(), filter, sort: None, limit: None, skip: None, group_by: None, joins: Vec::new(), insert_values: None, update_set: None })
    }

    fn parse_where_clause(&mut self) -> OvnResult<serde_json::Value> { self.parse_or_condition() }

    fn parse_or_condition(&mut self) -> OvnResult<serde_json::Value> {
        let left = self.parse_and_condition()?;
        if matches!(self.peek(), Some(SqlToken::Keyword(ref k)) if k == "OR") {
            self.advance();
            let right = self.parse_or_condition()?;
            Ok(serde_json::json!({ "$or": [left, right] }))
        } else { Ok(left) }
    }

    fn parse_and_condition(&mut self) -> OvnResult<serde_json::Value> {
        let left = self.parse_atom()?;
        if matches!(self.peek(), Some(SqlToken::Keyword(ref k)) if k == "AND") {
            self.advance();
            let right = self.parse_and_condition()?;
            let mut merged = serde_json::Map::new();
            if let Some(obj) = left.as_object() { for (k, v) in obj { merged.insert(k.clone(), v.clone()); } }
            if let Some(obj) = right.as_object() { for (k, v) in obj { merged.insert(k.clone(), v.clone()); } }
            Ok(serde_json::Value::Object(merged))
        } else { Ok(left) }
    }

    fn parse_atom(&mut self) -> OvnResult<serde_json::Value> {
        if let Some(SqlToken::Punctuation('(')) = self.peek().cloned() {
            self.advance();
            let r = self.parse_or_condition()?;
            self.expect_punctuation(')')?;
            return Ok(r);
        }
        if let Some(SqlToken::Identifier(f)) = self.peek().cloned() {
            let field_name = f.clone(); self.advance();
            if matches!(self.peek(), Some(SqlToken::Keyword(ref k)) if k == "IS") {
                self.advance();
                if matches!(self.peek(), Some(SqlToken::Keyword(ref k)) if k == "NULL") {
                    self.advance();
                    return Ok(serde_json::json!({ &field_name: serde_json::Value::Null }));
                }
            }
            if let Some(SqlToken::Operator(op)) = self.peek().cloned() {
                self.advance();
                if let Some(SqlToken::Literal(v)) = self.peek().cloned() {
                    self.advance();
                    let mql_op = match op.as_str() { "=" => "$eq", "!=" => "$ne", ">" => "$gt", ">=" => "$gte", "<" => "$lt", "<=" => "$lte", _ => "$eq" };
                    return Ok(serde_json::json!({ &field_name: { mql_op: v } }));
                }
            }
        }
        Err(self.syntax_error("Expected condition"))
    }

    fn parse_field_ref(&mut self) -> OvnResult<String> {
        if let Some(SqlToken::Identifier(n)) = self.peek().cloned() { self.advance(); Ok(n) }
        else { Err(self.syntax_error("Expected field reference")) }
    }

    fn expect_operator(&mut self, expected: &str) -> OvnResult<()> {
        if let Some(SqlToken::Operator(op)) = self.peek().cloned() {
            if op == expected { self.advance(); return Ok(()); }
        }
        Err(self.syntax_error(&format!("Expected '{}'", expected)))
    }

    fn expect_punctuation(&mut self, expected: char) -> OvnResult<()> {
        if let Some(SqlToken::Punctuation(ch)) = self.peek().cloned() {
            if ch == expected { self.advance(); return Ok(()); }
        }
        Err(self.syntax_error(&format!("Expected '{}'", expected)))
    }

    fn syntax_error(&self, msg: &str) -> OvnError {
        OvnError::QuerySyntaxError { position: self.pos, message: msg.to_string() }
    }
}

impl OvnEngine {
    pub fn parse_sql_query(&self, sql: &str) -> OvnResult<SqlQuery> {
        let mut parser = SqlParser::new(sql);
        parser.parse()
    }

    pub fn execute_sql(&self, sql: &str) -> OvnResult<Vec<serde_json::Value>> {
        let query = self.parse_sql_query(sql)?;
        match query.query_type.as_str() {
            "select" => {
                let collection = query.collection.as_ref().ok_or_else(|| OvnError::QuerySyntaxError { position: 0, message: "SELECT requires FROM".to_string() })?;
                let filter = query.filter.clone().unwrap_or(serde_json::json!({}));
                let opts = crate::engine::FindOptions {
                    projection: if query.fields.iter().any(|f| f == "*") { None } else {
                        let mut proj = std::collections::HashMap::new();
                        for f in &query.fields { proj.insert(f.clone(), 1); }
                        Some(proj)
                    },
                    sort: query.sort.clone(),
                    limit: query.limit,
                    skip: query.skip.unwrap_or(0),
                };
                self.find(collection, &filter, Some(opts))
            }
            "insert" => {
                let collection = query.collection.as_ref().ok_or_else(|| OvnError::QuerySyntaxError { position: 0, message: "INSERT requires INTO".to_string() })?;
                let mut ids = Vec::new();
                if let Some(values) = &query.insert_values {
                    for v in values { ids.push(serde_json::json!({ "_id": self.insert(collection, v)? })); }
                }
                Ok(ids)
            }
            "update" => {
                let collection = query.collection.as_ref().ok_or_else(|| OvnError::QuerySyntaxError { position: 0, message: "UPDATE requires collection".to_string() })?;
                if let Some(ref set) = query.update_set {
                    let update = serde_json::json!({ "$set": set });
                    let filter = query.filter.clone().unwrap_or(serde_json::json!({}));
                    let count = self.update(collection, &filter, &update)?;
                    Ok(vec![serde_json::json!({ "matched": count })])
                } else { Err(OvnError::QuerySyntaxError { position: 0, message: "UPDATE requires SET".to_string() }) }
            }
            "delete" => {
                let collection = query.collection.as_ref().ok_or_else(|| OvnError::QuerySyntaxError { position: 0, message: "DELETE requires FROM".to_string() })?;
                let filter = query.filter.clone().unwrap_or(serde_json::json!({}));
                let count = self.delete(collection, &filter)?;
                Ok(vec![serde_json::json!({ "deleted": count })])
            }
            _ => Err(OvnError::QuerySyntaxError { position: 0, message: format!("Unknown query type: {}", query.query_type) })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_tokenize_simple() {
        let tokens = SqlParser::tokenize("SELECT name, age FROM users");
        assert!(matches!(&tokens[0], SqlToken::Keyword(k) if k == "SELECT"));
    }
    #[test]
    fn test_parse_select_basic() {
        let mut p = SqlParser::new("SELECT * FROM users WHERE age > 18 ORDER BY name DESC LIMIT 10");
        let q = p.parse().unwrap();
        assert_eq!(q.query_type, "select");
        assert_eq!(q.collection, Some("users".to_string()));
        assert_eq!(q.limit, Some(10));
    }
    #[test]
    fn test_parse_insert() {
        let mut p = SqlParser::new("INSERT INTO users (name, age) VALUES ('Alice', 28)");
        let q = p.parse().unwrap();
        assert_eq!(q.query_type, "insert");
        assert!(q.insert_values.is_some());
    }
}
