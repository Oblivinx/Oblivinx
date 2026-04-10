//! Geospatial Indexing Engine (2D and 2DSphere).
//!
//! Provides R-Tree geometry cell-based indexing for `$geoWithin`, `$near`.

use crate::error::OvnResult;
use rstar::{RTree, RTreeObject, AABB};
use std::collections::HashSet;

/// Represents a geographic coordinate (Longitude, Latitude).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GeoPoint {
    pub lng: f64,
    pub lat: f64,
}

impl GeoPoint {
    pub fn new(lng: f64, lat: f64) -> Self {
        Self { lng, lat }
    }
}

/// A bounding box for 2D geometry queries.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BoundingBox {
    pub min: GeoPoint,
    pub max: GeoPoint,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GeoDocument {
    pub id: [u8; 16],
    pub point: GeoPoint,
}

impl RTreeObject for GeoDocument {
    type Envelope = AABB<[f64; 2]>;

    fn envelope(&self) -> Self::Envelope {
        AABB::from_point([self.point.lng, self.point.lat])
    }
}

impl rstar::PointDistance for GeoDocument {
    fn distance_2(&self, point: &[f64; 2]) -> f64 {
        let dx = self.point.lng - point[0];
        let dy = self.point.lat - point[1];
        dx * dx + dy * dy
    }
}

/// The Geospatial index covering a collection's location data.
pub struct GeoSpatialIndex {
    rtree: RTree<GeoDocument>,
}

impl Default for GeoSpatialIndex {
    fn default() -> Self {
        Self::new()
    }
}

impl GeoSpatialIndex {
    pub fn new() -> Self {
        Self {
            rtree: RTree::new(),
        }
    }

    /// Index a document containing a GeoPoint.
    pub fn index_point(&mut self, doc_id: &[u8; 16], point: GeoPoint) -> OvnResult<()> {
        let doc = GeoDocument { id: *doc_id, point };
        self.rtree.insert(doc);
        Ok(())
    }

    /// Search finding all documents located within a specific bounding box.
    pub fn find_within(&self, bbox: &BoundingBox) -> HashSet<[u8; 16]> {
        let aabb = AABB::from_corners([bbox.min.lng, bbox.min.lat], [bbox.max.lng, bbox.max.lat]);
        let mut results = HashSet::new();
        for doc in self.rtree.locate_in_envelope(&aabb) {
            results.insert(doc.id);
        }
        results
    }

    /// Search finding all documents near a specific point, ordered by distance.
    pub fn find_near(&self, point: GeoPoint, max_distance: f64) -> Vec<([u8; 16], f64)> {
        let mut results = Vec::new();
        let max_dist_2 = max_distance * max_distance;
        for doc in self
            .rtree
            .nearest_neighbor_iter_with_distance_2(&[point.lng, point.lat])
        {
            if doc.1 <= max_dist_2 {
                results.push((doc.0.id, doc.1.sqrt()));
            } else {
                break;
            }
        }
        results
    }
}
