//! OVN Binary Encoding (OBE) — document serialization format.
//!
//! OBE is a compact binary format inspired by BSON with improvements:
//! - Field IDs replace repeated field name strings for schema-aware collections
//! - Variable-length integers (varint / LEB128) reduce storage for small values
//! - 14 type tags covering all common data types
//!
//! ## OBE Document Structure
//! ```text
//! [4 bytes]  Document total length
//! [16 bytes] Document ID (128-bit UUID)
//! [8 bytes]  Transaction ID (version stamp)
//! [1 byte]   Tombstone flag (0x00 = live, 0xFF = deleted)
//! [varint]   Number of fields
//! [Fields...]
//! ```
//!
//! ## OBE Field Structure
//! ```text
//! [varint]  Field name length (0 = use Field ID)
//! [bytes]   Field name (UTF-8) OR Field ID (2 bytes if length == 0)
//! [1 byte]  Type tag
//! [...]     Value bytes (type-dependent)
//! ```

use std::collections::BTreeMap;
use uuid::Uuid;
use serde::{Serialize, Deserialize};

use crate::error::{OvnError, OvnResult};

// ── Type Tags ──────────────────────────────────────────────────

/// OBE type tag constants — each tag defines the encoding of the following value bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum TypeTag {
    Null = 0x01,
    BoolTrue = 0x02,
    BoolFalse = 0x03,
    Int32 = 0x04,
    Int64 = 0x05,
    Float64 = 0x06,
    String = 0x07,
    Binary = 0x08,
    Document = 0x09,
    Array = 0x0A,
    Timestamp = 0x0B,
    ObjectId = 0x0C,
    Decimal128 = 0x0D,
    Varint = 0x0E,
}

impl TypeTag {
    pub fn from_byte(b: u8) -> OvnResult<Self> {
        match b {
            0x01 => Ok(Self::Null),
            0x02 => Ok(Self::BoolTrue),
            0x03 => Ok(Self::BoolFalse),
            0x04 => Ok(Self::Int32),
            0x05 => Ok(Self::Int64),
            0x06 => Ok(Self::Float64),
            0x07 => Ok(Self::String),
            0x08 => Ok(Self::Binary),
            0x09 => Ok(Self::Document),
            0x0A => Ok(Self::Array),
            0x0B => Ok(Self::Timestamp),
            0x0C => Ok(Self::ObjectId),
            0x0D => Ok(Self::Decimal128),
            0x0E => Ok(Self::Varint),
            _ => Err(OvnError::UnknownTypeTag(b)),
        }
    }
}

// ── Varint LEB128 ──────────────────────────────────────────────

/// Encode a u64 value as LEB128 varint, returning the bytes written.
pub fn encode_varint(mut value: u64, buf: &mut Vec<u8>) -> usize {
    let start = buf.len();
    loop {
        let mut byte = (value & 0x7F) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        buf.push(byte);
        if value == 0 {
            break;
        }
    }
    buf.len() - start
}

/// Decode a LEB128 varint from a byte slice, returning (value, bytes_consumed).
pub fn decode_varint(buf: &[u8]) -> OvnResult<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift: u32 = 0;

    for (i, &byte) in buf.iter().enumerate() {
        if shift >= 64 {
            return Err(OvnError::VarintOverflow);
        }
        result |= ((byte & 0x7F) as u64) << shift;
        if byte & 0x80 == 0 {
            return Ok((result, i + 1));
        }
        shift += 7;
    }

    Err(OvnError::EncodingError("Unexpected end of varint".to_string()))
}

// ── OBE Value ──────────────────────────────────────────────────

/// A typed value in the OBE format.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ObeValue {
    Null,
    Bool(bool),
    Int32(i32),
    Int64(i64),
    Float64(f64),
    String(String),
    Binary(Vec<u8>),
    Document(BTreeMap<String, ObeValue>),
    Array(Vec<ObeValue>),
    Timestamp(u64),
    ObjectId([u8; 12]),
    Decimal128([u8; 16]),
}

impl ObeValue {
    /// Get the type tag for this value.
    pub fn type_tag(&self) -> TypeTag {
        match self {
            ObeValue::Null => TypeTag::Null,
            ObeValue::Bool(true) => TypeTag::BoolTrue,
            ObeValue::Bool(false) => TypeTag::BoolFalse,
            ObeValue::Int32(_) => TypeTag::Int32,
            ObeValue::Int64(_) => TypeTag::Int64,
            ObeValue::Float64(_) => TypeTag::Float64,
            ObeValue::String(_) => TypeTag::String,
            ObeValue::Binary(_) => TypeTag::Binary,
            ObeValue::Document(_) => TypeTag::Document,
            ObeValue::Array(_) => TypeTag::Array,
            ObeValue::Timestamp(_) => TypeTag::Timestamp,
            ObeValue::ObjectId(_) => TypeTag::ObjectId,
            ObeValue::Decimal128(_) => TypeTag::Decimal128,
        }
    }

    /// Check if this value is null.
    pub fn is_null(&self) -> bool {
        matches!(self, ObeValue::Null)
    }

    /// Try to get as string reference.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            ObeValue::String(s) => Some(s),
            _ => None,
        }
    }

    /// Try to get as i64 (coercing i32 to i64).
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            ObeValue::Int32(v) => Some(*v as i64),
            ObeValue::Int64(v) => Some(*v),
            _ => None,
        }
    }

    /// Try to get as f64.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            ObeValue::Float64(v) => Some(*v),
            ObeValue::Int32(v) => Some(*v as f64),
            ObeValue::Int64(v) => Some(*v as f64),
            _ => None,
        }
    }

    /// Try to get as bool.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            ObeValue::Bool(v) => Some(*v),
            _ => None,
        }
    }

    /// Try to get as document (object).
    pub fn as_document(&self) -> Option<&BTreeMap<String, ObeValue>> {
        match self {
            ObeValue::Document(d) => Some(d),
            _ => None,
        }
    }

    /// Try to get as array.
    pub fn as_array(&self) -> Option<&Vec<ObeValue>> {
        match self {
            ObeValue::Array(a) => Some(a),
            _ => None,
        }
    }

    /// Resolve a dot-notation path (e.g., "address.city") to a nested value.
    pub fn get_path(&self, path: &str) -> Option<&ObeValue> {
        let mut current = self;
        for segment in path.split('.') {
            match current {
                ObeValue::Document(map) => {
                    current = map.get(segment)?;
                }
                ObeValue::Array(arr) => {
                    let idx: usize = segment.parse().ok()?;
                    current = arr.get(idx)?;
                }
                _ => return None,
            }
        }
        Some(current)
    }

    /// Convert from a serde_json::Value.
    pub fn from_json(json: &serde_json::Value) -> Self {
        match json {
            serde_json::Value::Null => ObeValue::Null,
            serde_json::Value::Bool(b) => ObeValue::Bool(*b),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    if i >= i32::MIN as i64 && i <= i32::MAX as i64 {
                        ObeValue::Int32(i as i32)
                    } else {
                        ObeValue::Int64(i)
                    }
                } else if let Some(f) = n.as_f64() {
                    ObeValue::Float64(f)
                } else {
                    ObeValue::Null
                }
            }
            serde_json::Value::String(s) => ObeValue::String(s.clone()),
            serde_json::Value::Array(arr) => {
                ObeValue::Array(arr.iter().map(ObeValue::from_json).collect())
            }
            serde_json::Value::Object(obj) => {
                let mut map = BTreeMap::new();
                for (k, v) in obj {
                    map.insert(k.clone(), ObeValue::from_json(v));
                }
                ObeValue::Document(map)
            }
        }
    }

    /// Convert to a serde_json::Value.
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            ObeValue::Null => serde_json::Value::Null,
            ObeValue::Bool(b) => serde_json::Value::Bool(*b),
            ObeValue::Int32(i) => serde_json::Value::Number((*i).into()),
            ObeValue::Int64(i) => serde_json::Value::Number((*i).into()),
            ObeValue::Float64(f) => {
                serde_json::Number::from_f64(*f)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null)
            }
            ObeValue::String(s) => serde_json::Value::String(s.clone()),
            ObeValue::Binary(b) => {
                // Encode binary as base64 string in JSON
                use std::fmt::Write;
                let mut hex = String::with_capacity(b.len() * 2);
                for byte in b {
                    write!(hex, "{byte:02x}").unwrap();
                }
                serde_json::Value::String(hex)
            }
            ObeValue::Document(map) => {
                let obj: serde_json::Map<String, serde_json::Value> =
                    map.iter().map(|(k, v)| (k.clone(), v.to_json())).collect();
                serde_json::Value::Object(obj)
            }
            ObeValue::Array(arr) => {
                serde_json::Value::Array(arr.iter().map(|v| v.to_json()).collect())
            }
            ObeValue::Timestamp(ts) => serde_json::Value::Number((*ts).into()),
            ObeValue::ObjectId(oid) => {
                let mut hex = String::with_capacity(24);
                for byte in oid {
                    use std::fmt::Write;
                    write!(hex, "{byte:02x}").unwrap();
                }
                serde_json::Value::String(hex)
            }
            ObeValue::Decimal128(d) => {
                let mut hex = String::with_capacity(32);
                for byte in d {
                    use std::fmt::Write;
                    write!(hex, "{byte:02x}").unwrap();
                }
                serde_json::Value::String(hex)
            }
        }
    }
}

// ── OBE Field ──────────────────────────────────────────────────

/// A single field within an OBE-encoded document.
#[derive(Debug, Clone, PartialEq)]
pub struct ObeField {
    /// Field name (UTF-8 string)
    pub name: String,
    /// Field value
    pub value: ObeValue,
}

// ── OBE Document ───────────────────────────────────────────────

/// A complete OBE-encoded document.
#[derive(Debug, Clone, PartialEq)]
pub struct ObeDocument {
    /// Document ID (128-bit UUID)
    pub id: [u8; 16],
    /// Transaction ID (version stamp)
    pub txid: u64,
    /// Whether this document is deleted
    pub tombstone: bool,
    /// Document fields as an ordered map
    pub fields: BTreeMap<String, ObeValue>,
}

impl ObeDocument {
    /// Create a new document with a generated UUID.
    pub fn new() -> Self {
        Self {
            id: *Uuid::new_v4().as_bytes(),
            txid: 0,
            tombstone: false,
            fields: BTreeMap::new(),
        }
    }

    /// Create a document with a specific ID.
    pub fn with_id(id: [u8; 16]) -> Self {
        Self {
            id,
            txid: 0,
            tombstone: false,
            fields: BTreeMap::new(),
        }
    }

    /// Create a document from fields with auto-generated ID.
    pub fn from_fields(fields: BTreeMap<String, ObeValue>) -> Self {
        Self {
            id: *Uuid::new_v4().as_bytes(),
            txid: 0,
            tombstone: false,
            fields,
        }
    }

    /// Create a document from a JSON value.
    pub fn from_json(json: &serde_json::Value) -> OvnResult<Self> {
        let obj = json.as_object().ok_or_else(|| {
            OvnError::EncodingError("Document must be a JSON object".to_string())
        })?;

        let mut doc = Self::new();

        // Check for user-provided _id
        if let Some(id_val) = obj.get("_id") {
            if let Some(id_str) = id_val.as_str() {
                if let Ok(uuid) = Uuid::parse_str(id_str) {
                    doc.id = *uuid.as_bytes();
                }
            }
        }

        for (key, value) in obj {
            if key == "_id" {
                continue; // Already handled
            }
            doc.fields.insert(key.clone(), ObeValue::from_json(value));
        }

        Ok(doc)
    }

    /// Convert the document to a JSON value (includes _id).
    pub fn to_json(&self) -> serde_json::Value {
        let mut map = serde_json::Map::new();

        // Add _id as first field
        let uuid = Uuid::from_bytes(self.id);
        map.insert("_id".to_string(), serde_json::Value::String(uuid.to_string()));

        for (key, value) in &self.fields {
            map.insert(key.clone(), value.to_json());
        }

        serde_json::Value::Object(map)
    }

    /// Get a field value by name.
    pub fn get(&self, key: &str) -> Option<&ObeValue> {
        self.fields.get(key)
    }

    /// Get a nested field value using dot notation.
    pub fn get_path(&self, path: &str) -> Option<&ObeValue> {
        let mut parts = path.split('.');
        let first = parts.next()?;
        let mut current = self.fields.get(first)?;

        for segment in parts {
            match current {
                ObeValue::Document(map) => {
                    current = map.get(segment)?;
                }
                ObeValue::Array(arr) => {
                    let idx: usize = segment.parse().ok()?;
                    current = arr.get(idx)?;
                }
                _ => return None,
            }
        }

        Some(current)
    }

    /// Set a field value.
    pub fn set(&mut self, key: String, value: ObeValue) {
        self.fields.insert(key, value);
    }

    /// Remove a field.
    pub fn remove(&mut self, key: &str) -> Option<ObeValue> {
        self.fields.remove(key)
    }

    /// Get the document ID as a UUID string.
    pub fn id_string(&self) -> String {
        Uuid::from_bytes(self.id).to_string()
    }

    // ── Binary Serialization ───────────────────────────────────

    /// Serialize the document to OBE binary format.
    pub fn encode(&self) -> OvnResult<Vec<u8>> {
        let mut buf = Vec::with_capacity(256);

        // Reserve 4 bytes for total length (filled at the end)
        buf.extend_from_slice(&[0u8; 4]);

        // Document ID (16 bytes)
        buf.extend_from_slice(&self.id);

        // Transaction ID (8 bytes)
        buf.extend_from_slice(&self.txid.to_le_bytes());

        // Tombstone flag (1 byte)
        buf.push(if self.tombstone { 0xFF } else { 0x00 });

        // Number of fields (varint)
        encode_varint(self.fields.len() as u64, &mut buf);

        // Encode each field
        for (name, value) in &self.fields {
            encode_field(name, value, &mut buf)?;
        }

        // Write total length at the start
        let total_len = buf.len() as u32;
        buf[0..4].copy_from_slice(&total_len.to_le_bytes());

        if buf.len() > crate::MAX_DOCUMENT_SIZE {
            return Err(OvnError::DocumentTooLarge {
                size: buf.len(),
                max: crate::MAX_DOCUMENT_SIZE,
            });
        }

        Ok(buf)
    }

    /// Deserialize a document from OBE binary format.
    pub fn decode(buf: &[u8]) -> OvnResult<Self> {
        if buf.len() < 29 {
            return Err(OvnError::EncodingError(
                "OBE document buffer too small".to_string(),
            ));
        }

        let mut pos = 0;

        // Total length
        let total_len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        pos += 4;

        if buf.len() < total_len {
            return Err(OvnError::EncodingError(format!(
                "OBE document truncated: declared {} bytes but only {} available",
                total_len,
                buf.len()
            )));
        }

        // Document ID
        let mut id = [0u8; 16];
        id.copy_from_slice(&buf[pos..pos + 16]);
        pos += 16;

        // Transaction ID
        let txid = u64::from_le_bytes([
            buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3],
            buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7],
        ]);
        pos += 8;

        // Tombstone
        let tombstone = buf[pos] == 0xFF;
        pos += 1;

        // Field count
        let (field_count, varint_len) = decode_varint(&buf[pos..])?;
        pos += varint_len;

        // Decode fields
        let mut fields = BTreeMap::new();
        for _ in 0..field_count {
            let (name, value, consumed) = decode_field(&buf[pos..])?;
            fields.insert(name, value);
            pos += consumed;
        }

        Ok(Self {
            id,
            txid,
            tombstone,
            fields,
        })
    }
}

impl Default for ObeDocument {
    fn default() -> Self {
        Self::new()
    }
}

// ── Field Encoding/Decoding ────────────────────────────────────

/// Encode a single field (name + type tag + value) to the buffer.
fn encode_field(name: &str, value: &ObeValue, buf: &mut Vec<u8>) -> OvnResult<()> {
    // Field name length (varint)
    let name_bytes = name.as_bytes();
    encode_varint(name_bytes.len() as u64, buf);
    // Field name bytes
    buf.extend_from_slice(name_bytes);
    // Type tag (1 byte)
    buf.push(value.type_tag() as u8);
    // Value bytes
    encode_value(value, buf)?;
    Ok(())
}

/// Encode a value based on its type tag.
fn encode_value(value: &ObeValue, buf: &mut Vec<u8>) -> OvnResult<()> {
    match value {
        ObeValue::Null => {} // No value bytes
        ObeValue::Bool(_) => {} // Type tag encodes true/false
        ObeValue::Int32(v) => {
            buf.extend_from_slice(&v.to_le_bytes());
        }
        ObeValue::Int64(v) => {
            buf.extend_from_slice(&v.to_le_bytes());
        }
        ObeValue::Float64(v) => {
            buf.extend_from_slice(&v.to_le_bytes());
        }
        ObeValue::String(s) => {
            let bytes = s.as_bytes();
            encode_varint(bytes.len() as u64, buf);
            buf.extend_from_slice(bytes);
        }
        ObeValue::Binary(b) => {
            encode_varint(b.len() as u64, buf);
            buf.extend_from_slice(b);
        }
        ObeValue::Document(map) => {
            // Recursive: encode as sub-document
            encode_varint(map.len() as u64, buf);
            for (name, val) in map {
                encode_field(name, val, buf)?;
            }
        }
        ObeValue::Array(arr) => {
            encode_varint(arr.len() as u64, buf);
            for val in arr {
                buf.push(val.type_tag() as u8);
                encode_value(val, buf)?;
            }
        }
        ObeValue::Timestamp(ts) => {
            buf.extend_from_slice(&ts.to_le_bytes());
        }
        ObeValue::ObjectId(oid) => {
            buf.extend_from_slice(oid);
        }
        ObeValue::Decimal128(d) => {
            buf.extend_from_slice(d);
        }
    }
    Ok(())
}

/// Decode a single field from the buffer, returning (name, value, bytes_consumed).
fn decode_field(buf: &[u8]) -> OvnResult<(String, ObeValue, usize)> {
    let mut pos = 0;

    // Field name length
    let (name_len, vl) = decode_varint(&buf[pos..])?;
    pos += vl;
    let name_len = name_len as usize;

    // Field name
    if buf.len() < pos + name_len {
        return Err(OvnError::EncodingError("Field name truncated".to_string()));
    }
    let name = String::from_utf8(buf[pos..pos + name_len].to_vec())
        .map_err(|e| OvnError::EncodingError(format!("Invalid UTF-8 field name: {e}")))?;
    pos += name_len;

    // Type tag
    if pos >= buf.len() {
        return Err(OvnError::EncodingError("Missing type tag".to_string()));
    }
    let tag = TypeTag::from_byte(buf[pos])?;
    pos += 1;

    // Value
    let (value, consumed) = decode_value(tag, &buf[pos..])?;
    pos += consumed;

    Ok((name, value, pos))
}

/// Decode a value based on its type tag, returning (value, bytes_consumed).
fn decode_value(tag: TypeTag, buf: &[u8]) -> OvnResult<(ObeValue, usize)> {
    match tag {
        TypeTag::Null => Ok((ObeValue::Null, 0)),
        TypeTag::BoolTrue => Ok((ObeValue::Bool(true), 0)),
        TypeTag::BoolFalse => Ok((ObeValue::Bool(false), 0)),
        TypeTag::Int32 => {
            if buf.len() < 4 {
                return Err(OvnError::EncodingError("Int32 truncated".to_string()));
            }
            let v = i32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
            Ok((ObeValue::Int32(v), 4))
        }
        TypeTag::Int64 => {
            if buf.len() < 8 {
                return Err(OvnError::EncodingError("Int64 truncated".to_string()));
            }
            let v = i64::from_le_bytes([
                buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7],
            ]);
            Ok((ObeValue::Int64(v), 8))
        }
        TypeTag::Float64 => {
            if buf.len() < 8 {
                return Err(OvnError::EncodingError("Float64 truncated".to_string()));
            }
            let v = f64::from_le_bytes([
                buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7],
            ]);
            Ok((ObeValue::Float64(v), 8))
        }
        TypeTag::String => {
            let (len, vl) = decode_varint(buf)?;
            let len = len as usize;
            let start = vl;
            if buf.len() < start + len {
                return Err(OvnError::EncodingError("String truncated".to_string()));
            }
            let s = String::from_utf8(buf[start..start + len].to_vec())
                .map_err(|e| OvnError::EncodingError(format!("Invalid UTF-8: {e}")))?;
            Ok((ObeValue::String(s), start + len))
        }
        TypeTag::Binary => {
            let (len, vl) = decode_varint(buf)?;
            let len = len as usize;
            let start = vl;
            if buf.len() < start + len {
                return Err(OvnError::EncodingError("Binary truncated".to_string()));
            }
            let data = buf[start..start + len].to_vec();
            Ok((ObeValue::Binary(data), start + len))
        }
        TypeTag::Document => {
            let (field_count, mut pos) = decode_varint(buf)?;
            let mut map = BTreeMap::new();
            for _ in 0..field_count {
                let (name, value, consumed) = decode_field(&buf[pos..])?;
                map.insert(name, value);
                pos += consumed;
            }
            Ok((ObeValue::Document(map), pos))
        }
        TypeTag::Array => {
            let (count, mut pos) = decode_varint(buf)?;
            let mut arr = Vec::with_capacity(count as usize);
            for _ in 0..count {
                if pos >= buf.len() {
                    return Err(OvnError::EncodingError("Array truncated".to_string()));
                }
                let elem_tag = TypeTag::from_byte(buf[pos])?;
                pos += 1;
                let (val, consumed) = decode_value(elem_tag, &buf[pos..])?;
                arr.push(val);
                pos += consumed;
            }
            Ok((ObeValue::Array(arr), pos))
        }
        TypeTag::Timestamp => {
            if buf.len() < 8 {
                return Err(OvnError::EncodingError("Timestamp truncated".to_string()));
            }
            let v = u64::from_le_bytes([
                buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7],
            ]);
            Ok((ObeValue::Timestamp(v), 8))
        }
        TypeTag::ObjectId => {
            if buf.len() < 12 {
                return Err(OvnError::EncodingError("ObjectId truncated".to_string()));
            }
            let mut oid = [0u8; 12];
            oid.copy_from_slice(&buf[..12]);
            Ok((ObeValue::ObjectId(oid), 12))
        }
        TypeTag::Decimal128 => {
            if buf.len() < 16 {
                return Err(OvnError::EncodingError("Decimal128 truncated".to_string()));
            }
            let mut d = [0u8; 16];
            d.copy_from_slice(&buf[..16]);
            Ok((ObeValue::Decimal128(d), 16))
        }
        TypeTag::Varint => {
            let (v, consumed) = decode_varint(buf)?;
            Ok((ObeValue::Int64(v as i64), consumed))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_varint_roundtrip() {
        let values = [0u64, 1, 127, 128, 16383, 16384, u32::MAX as u64, u64::MAX];
        for &val in &values {
            let mut buf = Vec::new();
            encode_varint(val, &mut buf);
            let (decoded, consumed) = decode_varint(&buf).unwrap();
            assert_eq!(decoded, val, "Varint roundtrip failed for {val}");
            assert_eq!(consumed, buf.len());
        }
    }

    #[test]
    fn test_document_encode_decode() {
        let mut doc = ObeDocument::new();
        doc.set("name".to_string(), ObeValue::String("Alice Kim".to_string()));
        doc.set("age".to_string(), ObeValue::Int32(28));
        doc.set("active".to_string(), ObeValue::Bool(true));
        doc.set("score".to_string(), ObeValue::Float64(99.5));
        doc.set("tags".to_string(), ObeValue::Array(vec![
            ObeValue::String("admin".to_string()),
            ObeValue::String("developer".to_string()),
        ]));

        let mut addr = BTreeMap::new();
        addr.insert("city".to_string(), ObeValue::String("Jakarta".to_string()));
        addr.insert("country".to_string(), ObeValue::String("ID".to_string()));
        doc.set("address".to_string(), ObeValue::Document(addr));

        let encoded = doc.encode().unwrap();
        let decoded = ObeDocument::decode(&encoded).unwrap();

        assert_eq!(decoded.id, doc.id);
        assert_eq!(decoded.txid, doc.txid);
        assert_eq!(decoded.tombstone, doc.tombstone);
        assert_eq!(decoded.fields.len(), doc.fields.len());
        assert_eq!(decoded.get("name"), doc.get("name"));
        assert_eq!(decoded.get("age"), doc.get("age"));
        assert_eq!(decoded.get("active"), doc.get("active"));
        assert_eq!(decoded.get("tags"), doc.get("tags"));
        assert_eq!(decoded.get("address"), doc.get("address"));
    }

    #[test]
    fn test_null_and_binary() {
        let mut doc = ObeDocument::new();
        doc.set("nothing".to_string(), ObeValue::Null);
        doc.set("data".to_string(), ObeValue::Binary(vec![0xDE, 0xAD, 0xBE, 0xEF]));

        let encoded = doc.encode().unwrap();
        let decoded = ObeDocument::decode(&encoded).unwrap();
        assert_eq!(decoded.get("nothing"), Some(&ObeValue::Null));
        assert_eq!(decoded.get("data"), Some(&ObeValue::Binary(vec![0xDE, 0xAD, 0xBE, 0xEF])));
    }

    #[test]
    fn test_dot_notation_path() {
        let mut addr = BTreeMap::new();
        addr.insert("city".to_string(), ObeValue::String("Jakarta".to_string()));

        let mut doc = ObeDocument::new();
        doc.set("address".to_string(), ObeValue::Document(addr));

        assert_eq!(
            doc.get_path("address.city"),
            Some(&ObeValue::String("Jakarta".to_string()))
        );
        assert_eq!(doc.get_path("address.zip"), None);
        assert_eq!(doc.get_path("nonexistent.field"), None);
    }

    #[test]
    fn test_json_roundtrip() {
        let json = serde_json::json!({
            "name": "Bob",
            "age": 30,
            "scores": [100, 95, 88],
            "active": true,
            "meta": { "role": "user" }
        });

        let doc = ObeDocument::from_json(&json).unwrap();
        let back = doc.to_json();

        assert_eq!(back["name"], "Bob");
        assert_eq!(back["age"], 30);
        assert_eq!(back["active"], true);
    }
}
