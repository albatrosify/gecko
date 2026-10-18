use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrafficStat {
    pub id: String,
    pub date: String,
    pub playlist_id: String,
    pub playlist_name: String,
    pub stream_type: String,
    pub bytes: u64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TrafficTypeBreakdown {
    pub live: u64,
    pub movie: u64,
    pub series: u64,
    pub other: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistTrafficSummary {
    #[serde(rename = "playlistId")]
    pub playlist_id: String,
    #[serde(rename = "playlistName")]
    pub playlist_name: String,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "byType")]
    pub by_type: TrafficTypeBreakdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyTrafficPoint {
    pub date: String,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "byType")]
    pub by_type: TrafficTypeBreakdown,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TrafficSummary {
    #[serde(rename = "todayBytes")]
    pub today_bytes: u64,
    #[serde(rename = "monthBytes")]
    pub month_bytes: u64,
    #[serde(rename = "allTimeBytes")]
    pub all_time_bytes: u64,
    #[serde(rename = "monthlyQuotaBytes")]
    pub monthly_quota_bytes: u64,
    #[serde(rename = "monthPercent")]
    pub month_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrafficStatsResponse {
    pub range: TrafficDateRange,
    pub summary: TrafficSummary,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "byType")]
    pub by_type: TrafficTypeBreakdown,
    #[serde(rename = "byPlaylist")]
    pub by_playlist: Vec<PlaylistTrafficSummary>,
    pub daily: Vec<DailyTrafficPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrafficDateRange {
    #[serde(rename = "startDate")]
    pub start_date: String,
    #[serde(rename = "endDate")]
    pub end_date: String,
}
