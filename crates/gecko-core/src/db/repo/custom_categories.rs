use crate::db::pool::DbPool;
use crate::error::{CoreError, Result};
use crate::models::{CustomCategory, CustomCategoryItem, StreamType};
use rusqlite::params;

fn map_custom_category_row(row: &rusqlite::Row) -> rusqlite::Result<CustomCategory> {
    let type_str: String = row.get(2)?;
    let custom_type = StreamType::from_str_opt(&type_str).unwrap_or(StreamType::Live);
    let hidden_int: i32 = row.get(5)?;

    Ok(CustomCategory {
        id: row.get(0)?,
        playlist_id: row.get(1)?,
        custom_type,
        name: row.get(3)?,
        order: row.get(4)?,
        hidden: hidden_int != 0,
    })
}

fn map_custom_category_item_row(row: &rusqlite::Row) -> rusqlite::Result<CustomCategoryItem> {
    let type_str: String = row.get(3)?;
    let item_type = StreamType::from_str_opt(&type_str).unwrap_or(StreamType::Live);
    let extra_raw: Option<String> = row.get(7)?;
    let extra = extra_raw.and_then(|s| serde_json::from_str(&s).ok());

    Ok(CustomCategoryItem {
        id: row.get(0)?,
        custom_category_id: row.get(1)?,
        playlist_id: row.get(2)?,
        item_type,
        upstream_stream_id: row.get(4)?,
        upstream_source_id: row.get(5)?,
        stream_id: row.get(6)?,
        extra,
    })
}

pub fn get_custom_categories_by_playlist_and_type(
    pool: &DbPool,
    playlist_id: &str,
    custom_type: StreamType,
) -> Result<Vec<CustomCategory>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, playlistId, type, name, \"order\", hidden 
         FROM customCategories WHERE playlistId = ?1 AND type = ?2 ORDER BY \"order\" ASC",
    )?;
    let rows = stmt.query_map(params![playlist_id, custom_type.as_str()], map_custom_category_row)?;
    let mut cats = Vec::new();
    for c in rows {
        cats.push(c?);
    }
    Ok(cats)
}

pub fn get_custom_category_items_by_playlist_and_type(
    pool: &DbPool,
    playlist_id: &str,
    item_type: StreamType,
) -> Result<Vec<CustomCategoryItem>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, customCategoryId, playlistId, type, upstreamStreamId, upstreamSourceId, streamId, extra 
         FROM customCategoryItems WHERE playlistId = ?1 AND type = ?2",
    )?;
    let rows = stmt.query_map(params![playlist_id, item_type.as_str()], map_custom_category_item_row)?;
    let mut items = Vec::new();
    for i in rows {
        items.push(i?);
    }
    Ok(items)
}

pub fn insert_custom_category_sync(conn: &mut rusqlite::Connection, cat: &CustomCategory) -> Result<()> {
    conn.execute(
        "INSERT INTO customCategories (id, playlistId, type, name, \"order\", hidden)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            cat.id,
            cat.playlist_id,
            cat.custom_type.as_str(),
            cat.name,
            cat.order,
            cat.hidden as i32,
        ],
    )?;
    Ok(())
}

pub fn update_custom_category_sync(conn: &mut rusqlite::Connection, cat: &CustomCategory) -> Result<()> {
    let affected = conn.execute(
        "UPDATE customCategories SET name = ?1, \"order\" = ?2, hidden = ?3 WHERE id = ?4",
        params![cat.name, cat.order, cat.hidden as i32, cat.id],
    )?;
    if affected == 0 {
        return Err(CoreError::NotFound(format!("CustomCategory {} not found", cat.id)));
    }
    Ok(())
}

pub fn delete_custom_category_sync(conn: &mut rusqlite::Connection, id: &str) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM customCategoryItems WHERE customCategoryId = ?1", params![id])?;
    tx.execute("DELETE FROM customCategories WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

pub fn upsert_custom_category_items_batch_sync(
    conn: &mut rusqlite::Connection,
    items: &[CustomCategoryItem],
) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO customCategoryItems (id, customCategoryId, playlistId, type, upstreamStreamId, upstreamSourceId, streamId, extra)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET extra = excluded.extra",
        )?;
        for item in items {
            let extra_json = item.extra.as_ref().map(|e| serde_json::to_string(e).unwrap_or_default());
            stmt.execute(params![
                item.id,
                item.custom_category_id,
                item.playlist_id,
                item.item_type.as_str(),
                item.upstream_stream_id,
                item.upstream_source_id,
                item.stream_id,
                extra_json,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn get_all_custom_categories_by_playlist(
    pool: &DbPool,
    playlist_id: &str,
) -> Result<Vec<CustomCategory>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, playlistId, type, name, \"order\", hidden 
         FROM customCategories WHERE playlistId = ?1 ORDER BY \"order\" ASC",
    )?;
    let rows = stmt.query_map(params![playlist_id], map_custom_category_row)?;
    let mut cats = Vec::new();
    for c in rows {
        cats.push(c?);
    }
    Ok(cats)
}

pub fn get_custom_category_by_id(
    pool: &DbPool,
    id: &str,
) -> Result<Option<CustomCategory>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, playlistId, type, name, \"order\", hidden 
         FROM customCategories WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_custom_category_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn get_all_custom_category_items_by_playlist(
    pool: &DbPool,
    playlist_id: &str,
) -> Result<Vec<CustomCategoryItem>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, customCategoryId, playlistId, type, upstreamStreamId, upstreamSourceId, streamId, extra 
         FROM customCategoryItems WHERE playlistId = ?1",
    )?;
    let rows = stmt.query_map(params![playlist_id], map_custom_category_item_row)?;
    let mut items = Vec::new();
    for i in rows {
        items.push(i?);
    }
    Ok(items)
}

pub fn get_custom_category_item_by_id(
    pool: &DbPool,
    id: &str,
) -> Result<Option<CustomCategoryItem>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, customCategoryId, playlistId, type, upstreamStreamId, upstreamSourceId, streamId, extra 
         FROM customCategoryItems WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_custom_category_item_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn insert_custom_category_item_sync(
    conn: &mut rusqlite::Connection,
    item: &CustomCategoryItem,
) -> Result<()> {
    let extra_json = item.extra.as_ref().map(|e| serde_json::to_string(e).unwrap_or_default());
    conn.execute(
        "INSERT INTO customCategoryItems (id, customCategoryId, playlistId, type, upstreamStreamId, upstreamSourceId, streamId, extra)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET extra = excluded.extra",
        params![
            item.id,
            item.custom_category_id,
            item.playlist_id,
            item.item_type.as_str(),
            item.upstream_stream_id,
            item.upstream_source_id,
            item.stream_id,
            extra_json,
        ],
    )?;
    Ok(())
}

pub fn delete_custom_category_item_sync(conn: &mut rusqlite::Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM customCategoryItems WHERE id = ?1", params![id])?;
    Ok(())
}
