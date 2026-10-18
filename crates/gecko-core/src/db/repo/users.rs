use crate::db::pool::DbPool;
use crate::error::{CoreError, Result};
use crate::models::{User, UserRole};
use rusqlite::params;

pub fn get_user_by_email(pool: &DbPool, email: &str) -> Result<Option<User>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT id, email, password, role, createdAt FROM users WHERE email = ?1")?;
    let mut rows = stmt.query(params![email])?;

    if let Some(row) = rows.next()? {
        let role_str: String = row.get(3)?;
        let role = UserRole::from_str_opt(&role_str).unwrap_or(UserRole::User);
        Ok(Some(User {
            id: row.get(0)?,
            email: row.get(1)?,
            password: row.get(2)?,
            role,
            created_at: row.get(4)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn get_user_by_id(pool: &DbPool, id: &str) -> Result<Option<User>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT id, email, password, role, createdAt FROM users WHERE id = ?1")?;
    let mut rows = stmt.query(params![id])?;

    if let Some(row) = rows.next()? {
        let role_str: String = row.get(3)?;
        let role = UserRole::from_str_opt(&role_str).unwrap_or(UserRole::User);
        Ok(Some(User {
            id: row.get(0)?,
            email: row.get(1)?,
            password: row.get(2)?,
            role,
            created_at: row.get(4)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn list_users(pool: &DbPool) -> Result<Vec<User>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT id, email, password, role, createdAt FROM users ORDER BY createdAt DESC")?;
    let rows = stmt.query_map([], |row| {
        let role_str: String = row.get(3)?;
        let role = UserRole::from_str_opt(&role_str).unwrap_or(UserRole::User);
        Ok(User {
            id: row.get(0)?,
            email: row.get(1)?,
            password: row.get(2)?,
            role,
            created_at: row.get(4)?,
        })
    })?;

    let mut users = Vec::new();
    for u in rows {
        users.push(u?);
    }
    Ok(users)
}

pub fn insert_user_sync(conn: &mut rusqlite::Connection, user: &User) -> Result<()> {
    conn.execute(
        "INSERT INTO users (id, email, password, role, createdAt) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            user.id,
            user.email,
            user.password,
            user.role.as_str(),
            user.created_at,
        ],
    )?;
    Ok(())
}

pub fn update_user_password_sync(conn: &mut rusqlite::Connection, id: &str, new_password_hash: &str) -> Result<()> {
    let affected = conn.execute(
        "UPDATE users SET password = ?1 WHERE id = ?2",
        params![new_password_hash, id],
    )?;
    if affected == 0 {
        return Err(CoreError::NotFound(format!("User {} not found", id)));
    }
    Ok(())
}

pub fn delete_user_sync(conn: &mut rusqlite::Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM users WHERE id = ?1", params![id])?;
    Ok(())
}
