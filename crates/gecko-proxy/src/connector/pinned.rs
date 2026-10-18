use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;
use tracing::debug;

pub fn create_pinned_client(
    target_ip: Ipv4Addr,
    pinned_hostname: &str,
    port: u16,
) -> reqwest::Client {
    let clean_host = pinned_hostname
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();

    let target_addr = SocketAddr::new(IpAddr::V4(target_ip), port);
    debug!(
        "Creating IP-pinned client: host '{}' -> target IP {}",
        clean_host, target_addr
    );

    reqwest::Client::builder()
        .resolve(&clean_host, target_addr)
        // If the upstream issues a 302 redirect to a foreign hostname (e.g. per-node host),
        // reqwest does NOT apply the pin to the new hostname, avoiding infinite redirect loops!
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
        .gzip(true)
        .build()
        .unwrap_or_default()
}

pub fn create_standard_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
        .gzip(true)
        .build()
        .unwrap_or_default()
}
