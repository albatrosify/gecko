use crate::db::pool::DbPool;
use crate::error::Result;
use crate::models::{CategoryMapping, CategoryMappingExtra, StreamMapping, StreamMappingExtra, StreamType};
use rusqlite::params;

fn map_stream_mapping_row(row: &rusqlite::Row) -> rusqlite::Result<StreamMapping> {
    let type_str: String = row.get(2)?;
    let mapping_type = StreamType::from_str_opt(&type_str).unwrap_or(StreamType::Live);
    let extra_raw: Option<String> = row.get(4)?;
    let extra = extra_raw
        .and_then(|s| serde_json::from_str::<StreamMappingExtra>(&s).ok())
        .unwrap_or_default();

    Ok(StreamMapping {
        id: row.get(0)?,
        playlist_id: row.get(1)?,
        mapping_type,
        original_id: row.get(3)?,
        extra,
    })
}

fn map_category_mapping_row(row: &rusqlite::Row) -> rusqlite::Result<CategoryMapping> {
    let type_str: String = row.get(2)?;
    let mapping_type = StreamType::from_str_opt(&type_str).unwrap_or(StreamType::Live);
    let extra_raw: Option<String> = row.get(4)?;
    let extra = extra_raw
        .and_then(|s| serde_json::from_str::<CategoryMappingExtra>(&s).ok())
        .unwrap_or_default();

    Ok(CategoryMapping {
        id: row.get(0)?,
        playlist_id: row.get(1)?,
        mapping_type,
        original_id: row.get(3)?,
        extra,
    })
}

pub fn get_mappings_by_playlist_and_type(
    pool: &DbPool,
    playlist_id: &str,
    stream_type: StreamType,
) -> Result<Vec<StreamMapping>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, playlistId, type, originalId, extra 
         FROM mappings WHERE playlistId = ?1 AND type = ?2",
    )?;
    let rows = stmt.query_map(params![playlist_id, stream_type.as_str()], map_stream_mapping_row)?;
    let mut mappings = Vec::new();
    for m in rows {
        mappings.push(m?);
    }
    Ok(mappings)
}

pub fn get_category_mappings_by_playlist_and_type(
    pool: &DbPool,
    playlist_id: &str,
    stream_type: StreamType,
) -> Result<Vec<CategoryMapping>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, playlistId, type, originalId, extra 
         FROM categoryMappings WHERE playlistId = ?1 AND type = ?2",
    )?;
    let rows = stmt.query_map(params![playlist_id, stream_type.as_str()], map_category_mapping_row)?;
    let mut mappings = Vec::new();
    for m in rows {
        mappings.push(m?);
    }
    Ok(mappings)
}

pub fn get_all_category_mappings_by_playlist(
    pool: &DbPool,
    playlist_id: &str,
) -> Result<Vec<CategoryMapping>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, playlistId, type, originalId, extra 
         FROM categoryMappings WHERE playlistId = ?1",
    )?;
    let rows = stmt.query_map(params![playlist_id], map_category_mapping_row)?;
    let mut mappings = Vec::new();
    for m in rows {
        mappings.push(m?);
    }
    Ok(mappings)
}

pub fn upsert_mappings_batch_sync(
    conn: &mut rusqlite::Connection,
    mappings: &[StreamMapping],
) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO mappings (id, playlistId, type, originalId, extra)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET extra = excluded.extra",
        )?;
        for m in mappings {
            let extra_json = serde_json::to_string(&m.extra)?;
            stmt.execute(params![
                m.id,
                m.playlist_id,
                m.mapping_type.as_str(),
                m.original_id,
                extra_json,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn upsert_category_mappings_batch_sync(
    conn: &mut rusqlite::Connection,
    category_mappings: &[CategoryMapping],
) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO categoryMappings (id, playlistId, type, originalId, extra)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET extra = excluded.extra",
        )?;
        for cm in category_mappings {
            let extra_json = serde_json::to_string(&cm.extra)?;
            stmt.execute(params![
                cm.id,
                cm.playlist_id,
                cm.mapping_type.as_str(),
                cm.original_id,
                extra_json,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn get_mappings_by_playlist(
    pool: &DbPool,
    playlist_id: &str,
) -> Result<Vec<StreamMapping>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, playlistId, type, originalId, extra 
         FROM mappings WHERE playlistId = ?1",
    )?;
    let rows = stmt.query_map(params![playlist_id], map_stream_mapping_row)?;
    let mut mappings = Vec::new();
    for m in rows {
        mappings.push(m?);
    }
    Ok(mappings)
}

pub fn get_mapping_by_id(
    pool: &DbPool,
    id: &str,
) -> Result<Option<StreamMapping>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, playlistId, type, originalId, extra 
         FROM mappings WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_stream_mapping_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn insert_mapping_sync(
    conn: &mut rusqlite::Connection,
    m: &StreamMapping,
) -> Result<()> {
    let extra_json = serde_json::to_string(&m.extra)?;
    conn.execute(
        "INSERT INTO mappings (id, playlistId, type, originalId, extra)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET 
            playlistId = excluded.playlistId,
            type = excluded.type,
            originalId = excluded.originalId,
            extra = excluded.extra",
        params![m.id, m.playlist_id, m.mapping_type.as_str(), m.original_id, extra_json],
    )?;
    Ok(())
}

pub fn delete_mapping_sync(conn: &mut rusqlite::Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM mappings WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn delete_mappings_by_ids_sync(conn: &mut rusqlite::Connection, ids: &[String]) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("DELETE FROM mappings WHERE id = ?1")?;
        for id in ids {
            stmt.execute(params![id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn get_category_mapping_by_id(
    pool: &DbPool,
    id: &str,
) -> Result<Option<CategoryMapping>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, playlistId, type, originalId, extra 
         FROM categoryMappings WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_category_mapping_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn insert_category_mapping_sync(
    conn: &mut rusqlite::Connection,
    cm: &CategoryMapping,
) -> Result<()> {
    let extra_json = serde_json::to_string(&cm.extra)?;
    conn.execute(
        "INSERT INTO categoryMappings (id, playlistId, type, originalId, extra)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET 
            playlistId = excluded.playlistId,
            type = excluded.type,
            originalId = excluded.originalId,
            extra = excluded.extra",
        params![cm.id, cm.playlist_id, cm.mapping_type.as_str(), cm.original_id, extra_json],
    )?;
    Ok(())
}

pub fn delete_category_mapping_sync(conn: &mut rusqlite::Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM categoryMappings WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn delete_category_mappings_by_ids_sync(conn: &mut rusqlite::Connection, ids: &[String]) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("DELETE FROM categoryMappings WHERE id = ?1")?;
        for id in ids {
            stmt.execute(params![id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn delete_mappings_by_playlist_sync(conn: &mut rusqlite::Connection, playlist_id: &str) -> Result<()> {
    conn.execute("DELETE FROM mappings WHERE playlistId = ?1", params![playlist_id])?;
    Ok(())
}

pub fn delete_category_mappings_by_playlist_sync(conn: &mut rusqlite::Connection, playlist_id: &str) -> Result<()> {
    conn.execute("DELETE FROM categoryMappings WHERE playlistId = ?1", params![playlist_id])?;
    Ok(())
}
