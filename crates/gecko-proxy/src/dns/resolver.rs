use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::debug;

pub const DNS_CACHE_TTL: Duration = Duration::from_secs(300); // 5 minutes

#[derive(Clone, Debug)]
pub struct DnsCacheEntry {
    pub ips: Vec<Ipv4Addr>,
    pub expires_at: Instant,
}

#[derive(Clone, Default)]
pub struct DnsResolver {
    cache: Arc<RwLock<HashMap<String, DnsCacheEntry>>>,
}

impl DnsResolver {
    pub fn new() -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn extract_hostname_and_port(input: &str) -> (String, u16) {
        let mut trimmed = input.trim();
        let default_port = if trimmed.starts_with("https://") {
            443
        } else {
            80
        };

        if let Some(idx) = trimmed.find("://") {
            trimmed = &trimmed[idx + 3..];
        }
        if let Some(idx) = trimmed.find('/') {
            trimmed = &trimmed[..idx];
        }
        if let Some(idx) = trimmed.find('?') {
            trimmed = &trimmed[..idx];
        }

        if let Some((host, port_str)) = trimmed.split_once(':') {
            let port = port_str.parse::<u16>().unwrap_or(default_port);
            (host.to_ascii_lowercase(), port)
        } else {
            (trimmed.to_ascii_lowercase(), default_port)
        }
    }

    pub fn is_private_ip(ip: &Ipv4Addr) -> bool {
        let octets = ip.octets();
        octets[0] == 127
            || octets[0] == 10
            || (octets[0] == 192 && octets[1] == 168)
            || (octets[0] == 169 && octets[1] == 254)
            || (octets[0] == 172 && (16..=31).contains(&octets[1]))
            || octets[0] == 0
    }

    /// Resolves all IPv4 A-records for a hostname, caching for 5 minutes.
    pub async fn resolve_host_ips(&self, hostname: &str) -> Vec<Ipv4Addr> {
        let clean_host = hostname.trim().trim_end_matches('.').to_ascii_lowercase();

        // 1. Check in-memory cache
        {
            let cache = self.cache.read().await;
            if let Some(entry) = cache.get(&clean_host) {
                if Instant::now() < entry.expires_at {
                    return entry.ips.clone();
                }
            }
        }

        // 2. Perform async DNS lookup with port 80
        let query = format!("{}:80", clean_host);
        let mut resolved_ips = Vec::new();

        if let Ok(addrs) = tokio::net::lookup_host(&query).await {
            for addr in addrs {
                if let IpAddr::V4(ipv4) = addr.ip() {
                    if !resolved_ips.contains(&ipv4) {
                        resolved_ips.push(ipv4);
                    }
                }
            }
        }

        if resolved_ips.is_empty() {
            // Direct IP parse fallback
            if let Ok(ip) = clean_host.parse::<Ipv4Addr>() {
                resolved_ips.push(ip);
            }
        }

        debug!("Resolved {} to {:?}", clean_host, resolved_ips);

        // 3. Cache results
        if !resolved_ips.is_empty() {
            let mut cache = self.cache.write().await;
            cache.insert(
                clean_host,
                DnsCacheEntry {
                    ips: resolved_ips.clone(),
                    expires_at: Instant::now() + DNS_CACHE_TTL,
                },
            );
        }

        resolved_ips
    }

    pub async fn clear_cache(&self) {
        self.cache.write().await.clear();
    }
}
