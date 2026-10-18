use crate::db::pool::DbPool;
use crate::error::Result;
use crate::models::{
    DailyTrafficPoint, PlaylistTrafficSummary, TrafficDateRange, TrafficStat, TrafficStatsResponse,
    TrafficSummary, TrafficTypeBreakdown,
};
use rusqlite::params;
use std::collections::HashMap;

pub fn record_traffic_bytes_sync(
    conn: &mut rusqlite::Connection,
    date: &str,
    playlist_id: &str,
    playlist_name: &str,
    stream_type: &str,
    bytes: u64,
    updated_at: i64,
) -> Result<()> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO traffic_stats (id, date, playlistId, playlistName, streamType, bytes, updatedAt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(date, playlistId, streamType) DO UPDATE SET
            bytes = bytes + excluded.bytes,
            updatedAt = excluded.updatedAt,
            playlistName = excluded.playlistName",
        params![id, date, playlist_id, playlist_name, stream_type, bytes, updated_at],
    )?;
    Ok(())
}

pub fn get_traffic_stats_for_range(
    pool: &DbPool,
    start_date: &str,
    end_date: &str,
    monthly_quota_bytes: u64,
) -> Result<TrafficStatsResponse> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, date, playlistId, playlistName, streamType, bytes, updatedAt 
         FROM traffic_stats WHERE date >= ?1 AND date <= ?2 ORDER BY date ASC",
    )?;

    let rows = stmt.query_map(params![start_date, end_date], |row| {
        Ok(TrafficStat {
            id: row.get(0)?,
            date: row.get(1)?,
            playlist_id: row.get(2)?,
            playlist_name: row.get(3)?,
            stream_type: row.get(4)?,
            bytes: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;

    let mut total_bytes: u64 = 0;
    let mut total_by_type = TrafficTypeBreakdown::default();
    let mut playlist_map: HashMap<String, PlaylistTrafficSummary> = HashMap::new();
    let mut daily_map: HashMap<String, DailyTrafficPoint> = HashMap::new();

    for r in rows {
        let stat = r?;
        total_bytes += stat.bytes;

        match stat.stream_type.as_str() {
            "live" => total_by_type.live += stat.bytes,
            "movie" => total_by_type.movie += stat.bytes,
            "series" => total_by_type.series += stat.bytes,
            _ => total_by_type.other += stat.bytes,
        }

        // Aggregate by playlist
        let p_entry = playlist_map
            .entry(stat.playlist_id.clone())
            .or_insert_with(|| PlaylistTrafficSummary {
                playlist_id: stat.playlist_id.clone(),
                playlist_name: stat.playlist_name.clone(),
                total_bytes: 0,
                by_type: TrafficTypeBreakdown::default(),
            });
        p_entry.total_bytes += stat.bytes;
        match stat.stream_type.as_str() {
            "live" => p_entry.by_type.live += stat.bytes,
            "movie" => p_entry.by_type.movie += stat.bytes,
            "series" => p_entry.by_type.series += stat.bytes,
            _ => p_entry.by_type.other += stat.bytes,
        }

        // Aggregate by day
        let d_entry = daily_map
            .entry(stat.date.clone())
            .or_insert_with(|| DailyTrafficPoint {
                date: stat.date.clone(),
                total_bytes: 0,
                by_type: TrafficTypeBreakdown::default(),
            });
        d_entry.total_bytes += stat.bytes;
        match stat.stream_type.as_str() {
            "live" => d_entry.by_type.live += stat.bytes,
            "movie" => d_entry.by_type.movie += stat.bytes,
            "series" => d_entry.by_type.series += stat.bytes,
            _ => d_entry.by_type.other += stat.bytes,
        }
    }

    let mut daily_vec: Vec<DailyTrafficPoint> = daily_map.into_values().collect();
    daily_vec.sort_by(|a, b| a.date.cmp(&b.date));

    let mut playlist_vec: Vec<PlaylistTrafficSummary> = playlist_map.into_values().collect();
    playlist_vec.sort_by(|a, b| b.total_bytes.cmp(&a.total_bytes));

    let month_percent = if monthly_quota_bytes > 0 {
        (total_bytes as f64 / monthly_quota_bytes as f64) * 100.0
    } else {
        0.0
    };

    Ok(TrafficStatsResponse {
        range: TrafficDateRange {
            start_date: start_date.to_string(),
            end_date: end_date.to_string(),
        },
        summary: TrafficSummary {
            today_bytes: daily_vec.last().map(|d| d.total_bytes).unwrap_or(0),
            month_bytes: total_bytes,
            all_time_bytes: total_bytes,
            monthly_quota_bytes,
            month_percent,
        },
        total_bytes,
        by_type: total_by_type,
        by_playlist: playlist_vec,
        daily: daily_vec,
    })
}
