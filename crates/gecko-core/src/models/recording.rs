use super::mapping::StreamType;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordingStatus {
    Recording,
    Completed,
    Failed,
    Cancelled,
}

impl RecordingStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            RecordingStatus::Recording => "recording",
            RecordingStatus::Completed => "completed",
            RecordingStatus::Failed => "failed",
            RecordingStatus::Cancelled => "cancelled",
        }
    }

    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "recording" => Some(RecordingStatus::Recording),
            "completed" => Some(RecordingStatus::Completed),
            "failed" => Some(RecordingStatus::Failed),
            "cancelled" => Some(RecordingStatus::Cancelled),
            _ => None,
        }
    }
}

impl std::fmt::Display for RecordingStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recording {
    pub id: String,
    pub user_id: String,
    pub playlist_id: Option<String>,
    pub source_id: String,
    pub stream_id: String,
    pub stream_name: String,
    pub channel_name: Option<String>,
    #[serde(rename = "type")]
    pub stream_type: StreamType,
    pub status: RecordingStatus,
    pub start_time: String,
    pub end_time: Option<String>,
    pub duration_seconds: u64,
    pub file_size_bytes: u64,
    pub file_path: String,
    #[serde(default)]
    pub extra: Option<serde_json::Value>,
}

/// Deterministically computes a positive 32-bit integer for a recording ID.
/// Maps into the 900,000,000 - 999,999,999 range so it fits in signed 32-bit int
/// and avoids collisions with typical upstream stream IDs. Prevents Android client crashes.
pub fn recording_id_to_numeric(rec_id: &str) -> u32 {
    let mut hash: i32 = 5381;
    for b in rec_id.bytes() {
        hash = hash.wrapping_shl(5).wrapping_add(hash).wrapping_add(b as i32);
    }
    let positive = hash.abs() as u32;
    900_000_000 + (positive % 100_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_numeric_id_range() {
        let rec_id = "rec_2883a608-38ca-43c6-aaf7-61057d358a0c";
        let num = recording_id_to_numeric(rec_id);
        assert!(num >= 900_000_000 && num <= 999_999_999);
    }
}
