use crate::state::AppState;
use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use gecko_core::crypto::{create_jwt, hash_password, verify_jwt, verify_password, JwtClaims};
use gecko_core::models::{User, UserRole, UserSummary};
use gecko_core::repo;
use serde::{Deserialize, Serialize};

pub const JWT_SECRET_DEFAULT: &str = "gecko_jwt_secret_default_key_change_in_production";

pub fn get_jwt_secret() -> String {
    std::env::var("JWT_SECRET").unwrap_or_else(|_| JWT_SECRET_DEFAULT.to_string())
}

#[derive(Debug, Deserialize)]
pub struct LoginPayload {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: UserSummary,
}

pub async fn handle_login(
    State(state): State<AppState>,
    Json(payload): Json<LoginPayload>,
) -> Response {
    let user = match repo::users::get_user_by_email(&state.db.pool, &payload.email) {
        Ok(Some(u)) => u,
        _ => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Invalid email or password" })),
            )
                .into_response()
        }
    };

    match verify_password(&payload.password, &user.password) {
        Ok(true) => {
            let secret = get_jwt_secret();
            let token = match create_jwt(&user.id, &user.email, user.role.as_str(), &secret, 86400 * 30)
            {
                Ok(t) => t,
                Err(e) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({ "error": format!("JWT error: {}", e) })),
                    )
                        .into_response();
                }
            };

            (
                StatusCode::OK,
                Json(AuthResponse {
                    token,
                    user: user.into(),
                }),
            )
                .into_response()
        }
        _ => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid email or password" })),
        )
            .into_response(),
    }
}

pub async fn handle_register(
    State(state): State<AppState>,
    Json(payload): Json<LoginPayload>,
) -> Response {
    let existing_users = repo::users::list_users(&state.db.pool).unwrap_or_default();
    let role = if existing_users.is_empty() {
        UserRole::Admin
    } else {
        UserRole::User
    };

    if existing_users.iter().any(|u| u.email == payload.email) {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "Email already in use" })),
        )
            .into_response();
    }

    let password_hash = match hash_password(&payload.password) {
        Ok(h) => h,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("Hash error: {}", e) })),
            )
                .into_response();
        }
    };

    let user_id = uuid::Uuid::new_v4().to_string();
    let user = User {
        id: user_id,
        email: payload.email,
        password: password_hash,
        role,
        created_at: Some(chrono::Utc::now().timestamp()),
    };

    let user_clone = user.clone();
    if let Err(e) = state
        .db
        .writer
        .write(move |conn| repo::users::insert_user_sync(conn, &user_clone))
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("DB error: {}", e) })),
        )
            .into_response();
    }

    let secret = get_jwt_secret();
    let token = create_jwt(&user.id, &user.email, user.role.as_str(), &secret, 86400 * 30).unwrap();

    (
        StatusCode::OK,
        Json(AuthResponse {
            token,
            user: user.into(),
        }),
    )
        .into_response()
}

pub async fn handle_me(
    State(state): State<AppState>,
    claims: axum::extract::Extension<JwtClaims>,
) -> Response {
    if let Ok(Some(u)) = repo::users::get_user_by_id(&state.db.pool, &claims.sub) {
        (StatusCode::OK, Json(UserSummary::from(u))).into_response()
    } else {
        StatusCode::UNAUTHORIZED.into_response()
    }
}

pub async fn require_auth_middleware(
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let auth_header = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok());

    let token = match auth_header {
        Some(h) if h.starts_with("Bearer ") => &h[7..],
        _ => return Err(StatusCode::UNAUTHORIZED),
    };

    let secret = get_jwt_secret();
    match verify_jwt(token, &secret) {
        Ok(claims) => {
            req.extensions_mut().insert(claims);
            Ok(next.run(req).await)
        }
        Err(_) => Err(StatusCode::UNAUTHORIZED),
    }
}
