use crate::error::{CoreError, Result};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

pub fn hash_password(password: &str) -> Result<String> {
    bcrypt::hash(password, bcrypt::DEFAULT_COST).map_err(CoreError::Bcrypt)
}

pub fn verify_password(password: &str, hash: &str) -> Result<bool> {
    bcrypt::verify(password, hash).map_err(CoreError::Bcrypt)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwtClaims {
    pub sub: String,
    pub email: String,
    pub role: String,
    pub exp: usize,
}

pub fn create_jwt(
    user_id: &str,
    email: &str,
    role: &str,
    secret: &str,
    duration_secs: u64,
) -> Result<String> {
    let now = chrono::Utc::now().timestamp() as u64;
    let claims = JwtClaims {
        sub: user_id.to_string(),
        email: email.to_string(),
        role: role.to_string(),
        exp: (now + duration_secs) as usize,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(CoreError::Jwt)
}

pub fn verify_jwt(token: &str, secret: &str) -> Result<JwtClaims> {
    let token_data = decode::<JwtClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(CoreError::Jwt)?;

    Ok(token_data.claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_password_hashing() {
        let password = "super_secret_password";
        let hash = hash_password(password).unwrap();
        assert!(verify_password(password, &hash).unwrap());
        assert!(!verify_password("wrong_password", &hash).unwrap());
    }

    #[test]
    fn test_node_bcrypt_compatibility() {
        // Real hash produced by Node.js bcryptjs for password 'my-test-password'
        let node_hash_2b = "$2b$10$CAIIEIPdYEZ1nVqtKlQQ.e7uGsQ50MlOfsUCaTqqYPSixCvexk6dK";
        assert!(verify_password("my-test-password", node_hash_2b).unwrap());
        assert!(!verify_password("wrong-password", node_hash_2b).unwrap());

        // Also test $2a$ format
        let node_hash_2a = "$2a$10$CAIIEIPdYEZ1nVqtKlQQ.e7uGsQ50MlOfsUCaTqqYPSixCvexk6dK";
        assert!(verify_password("my-test-password", node_hash_2a).unwrap());
    }

    #[test]
    fn test_jwt_lifecycle() {
        let secret = "test_jwt_secret_key_12345";
        let token = create_jwt("user-1", "admin@gecko.tv", "admin", secret, 3600).unwrap();
        let claims = verify_jwt(&token, secret).unwrap();
        assert_eq!(claims.sub, "user-1");
        assert_eq!(claims.email, "admin@gecko.tv");
        assert_eq!(claims.role, "admin");
    }
}
