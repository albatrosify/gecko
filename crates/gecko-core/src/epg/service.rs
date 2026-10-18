use crate::error::{CoreError, Result};
use crate::models::{EpgSource, Playlist, Source};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;
use tracing::{info, warn};

pub const EPG_CACHE_FRESH_SECS: u64 = 6 * 3600; // 6 hours
pub const EPG_CACHE_MAX_AGE_SECS: u64 = 24 * 3600; // 24 hours

pub fn get_epg_cache_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("EPG_CACHE_DIR") {
        PathBuf::from(dir)
    } else {
        PathBuf::from("data/epg-cache")
    }
}

pub fn get_epg_cache_path(playlist_id: &str) -> PathBuf {
    let safe_id = playlist_id
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect::<String>();
    get_epg_cache_dir().join(format!("epg_{}.xml.gz", safe_id))
}

pub async fn build_playlist_epg(
    playlist: &Playlist,
    sources: &[Source],
    epgs: &[EpgSource],
) -> Result<PathBuf> {
    let cache_path = get_epg_cache_path(&playlist.id);
    if let Some(parent) = cache_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap_or_default();

    let mut xml_parts: Vec<String> = Vec::new();

    // 1. Fetch custom EPG URLs
    for epg in epgs {
        if epg.url.is_empty() {
            continue;
        }
        match fetch_epg_xml(&client, &eppg_url(&epg.url)).await {
            Ok(xml) => xml_parts.push(xml),
            Err(e) => warn!("Failed to fetch custom EPG {}: {}", epg.url, e),
        }
    }

    // 2. Fetch upstream sources with use_upstream_epg
    for source in sources {
        if source.extra.use_upstream_epg.unwrap_or(false) && !source.url.is_empty() {
            let user = source.username.as_deref().unwrap_or("");
            let pass = source.password.as_deref().unwrap_or("");
            let url = format!(
                "{}/xmltv.php?username={}&password={}",
                source.url.trim_end_matches('/'),
                user,
                pass
            );
            info!("Fetching upstream XMLTV EPG from {}", source.url);
            match fetch_epg_xml(&client, &url).await {
                Ok(xml) => xml_parts.push(xml),
                Err(e) => warn!("Failed to fetch upstream EPG from {}: {}", source.url, e),
            }
        }
    }

    // 3. Merge XMLTV documents
    let merged_xml = if xml_parts.is_empty() {
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv></tv>".to_string()
    } else if xml_parts.len() == 1 {
        xml_parts.remove(0)
    } else {
        merge_xmltv_documents(&xml_parts)
    };

    // 4. Compress to .xml.gz and atomic rename
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(merged_xml.as_bytes())
        .map_err(|e| CoreError::Other(e.to_string()))?;
    let compressed = encoder
        .finish()
        .map_err(|e| CoreError::Other(e.to_string()))?;

    let temp_path = format!("{}.tmp.{}", cache_path.display(), uuid::Uuid::new_v4());
    tokio::fs::write(&temp_path, &compressed)
        .await
        .map_err(|e| CoreError::Other(e.to_string()))?;
    tokio::fs::rename(&temp_path, &cache_path)
        .await
        .map_err(|e| CoreError::Other(e.to_string()))?;

    info!(
        "EPG cache successfully generated for playlist '{}' ({} KB gzipped)",
        playlist.name,
        compressed.len() / 1024
    );

    Ok(cache_path)
}

fn eppg_url(url: &str) -> String {
    url.to_string()
}

async fn fetch_epg_xml(client: &reqwest::Client, url: &str) -> Result<String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| CoreError::Other(e.to_string()))?;

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| CoreError::Other(e.to_string()))?;

    // Check if gzipped (magic bytes 0x1f, 0x8b or .gz url)
    if bytes.starts_with(&[0x1f, 0x8b]) || url.ends_with(".gz") {
        let mut decoder = GzDecoder::new(&bytes[..]);
        let mut xml = String::new();
        decoder
            .read_to_string(&mut xml)
            .map_err(|e| CoreError::Other(format!("Gzip decode failed: {}", e)))?;
        Ok(xml)
    } else {
        String::from_utf8(bytes.to_vec())
            .map_err(|e| CoreError::Other(format!("UTF-8 decode failed: {}", e)))
    }
}

fn merge_xmltv_documents(parts: &[String]) -> String {
    let mut merged = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv>\n");
    for part in parts {
        if let Some(start_idx) = part.find("<tv") {
            if let Some(close_tag_idx) = part[start_idx..].find('>') {
                let inner_start = start_idx + close_tag_idx + 1;
                if let Some(end_idx) = part.rfind("</tv>") {
                    if end_idx > inner_start {
                        merged.push_str(&part[inner_start..end_idx]);
                        merged.push('\n');
                    }
                }
            }
        }
    }
    merged.push_str("</tv>");
    merged
}
