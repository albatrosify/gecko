use super::types::*;
use crate::error::{CoreError, Result};
use std::time::Duration;
use tracing::warn;

#[derive(Clone)]
pub struct XtreamClient {
    client: reqwest::Client,
    base_url: String,
    username: Option<String>,
    password: Option<String>,
}

impl XtreamClient {
    pub fn new(base_url: &str, username: Option<&str>, password: Option<&str>) -> Self {
        let clean_url = base_url.trim_end_matches('/').to_string();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
            .gzip(true)
            .build()
            .unwrap_or_default();

        Self {
            client,
            base_url: clean_url,
            username: username.map(|s| s.to_string()),
            password: password.map(|s| s.to_string()),
        }
    }

    async fn request_json<T: serde::de::DeserializeOwned>(
        &self,
        action: Option<&str>,
        extra_query: &[(&str, &str)],
        timeout: Duration,
    ) -> Result<T> {
        let endpoint = format!("{}/player_api.php", self.base_url);
        let mut req = self.client.get(&endpoint).timeout(timeout);

        if let Some(user) = &self.username {
            req = req.query(&[("username", user)]);
        }
        if let Some(pass) = &self.password {
            req = req.query(&[("password", pass)]);
        }
        if let Some(act) = action {
            req = req.query(&[("action", act)]);
        }
        if !extra_query.is_empty() {
            req = req.query(extra_query);
        }

        let resp = req
            .send()
            .await
            .map_err(|e| CoreError::Other(format!("Upstream request failed: {}", e)))?;

        let status = resp.status();
        if !status.is_success() {
            warn!("Upstream returned non-200 status: {}", status);
        }

        let data = resp
            .json::<T>()
            .await
            .map_err(|e| CoreError::Other(format!("Failed to parse upstream JSON: {}", e)))?;

        Ok(data)
    }

    pub async fn authenticate(&self) -> Result<XtreamAuthResponse> {
        self.request_json(None, &[], Duration::from_secs(15)).await
    }

    pub async fn get_live_categories(&self) -> Result<Vec<XtreamCategory>> {
        self.request_json(Some("get_live_categories"), &[], Duration::from_secs(30))
            .await
    }

    pub async fn get_live_streams(&self) -> Result<Vec<XtreamLiveStream>> {
        self.request_json(Some("get_live_streams"), &[], Duration::from_secs(45))
            .await
    }

    pub async fn get_vod_categories(&self) -> Result<Vec<XtreamCategory>> {
        self.request_json(Some("get_vod_categories"), &[], Duration::from_secs(30))
            .await
    }

    pub async fn get_vod_streams(&self) -> Result<Vec<XtreamVodStream>> {
        self.request_json(Some("get_vod_streams"), &[], Duration::from_secs(90))
            .await
    }

    pub async fn get_series_categories(&self) -> Result<Vec<XtreamCategory>> {
        self.request_json(Some("get_series_categories"), &[], Duration::from_secs(30))
            .await
    }

    pub async fn get_series(&self) -> Result<Vec<XtreamSeries>> {
        self.request_json(Some("get_series"), &[], Duration::from_secs(90))
            .await
    }

    pub async fn get_series_info(&self, series_id: u32) -> Result<serde_json::Value> {
        let sid_str = series_id.to_string();
        self.request_json(
            Some("get_series_info"),
            &[("series_id", &sid_str)],
            Duration::from_secs(30),
        )
        .await
    }

    pub async fn get_vod_info(&self, vod_id: u32) -> Result<serde_json::Value> {
        let vid_str = vod_id.to_string();
        self.request_json(
            Some("get_vod_info"),
            &[("vod_id", &vid_str)],
            Duration::from_secs(30),
        )
        .await
    }

    pub async fn get_live_info(&self, stream_id: u32) -> Result<serde_json::Value> {
        let sid_str = stream_id.to_string();
        self.request_json(
            Some("get_live_info"),
            &[("stream_id", &sid_str)],
            Duration::from_secs(30),
        )
        .await
    }
}
