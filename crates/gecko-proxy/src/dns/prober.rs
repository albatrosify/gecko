use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::time::timeout;

#[derive(Debug, Clone)]
pub struct RankedIp {
    pub ip: Ipv4Addr,
    pub latency: Duration,
    pub healthy: bool,
}

pub async fn probe_ip_latency(ip: Ipv4Addr, port: u16, max_timeout: Duration) -> Option<Duration> {
    let addr = SocketAddr::V4(SocketAddrV4::new(ip, port));
    let start = Instant::now();

    match timeout(max_timeout, TcpStream::connect(addr)).await {
        Ok(Ok(_stream)) => Some(start.elapsed()),
        _ => None,
    }
}

pub async fn rank_ips(ips: &[Ipv4Addr], port: u16) -> Vec<RankedIp> {
    let mut tasks = Vec::new();

    for &ip in ips {
        tasks.push(async move {
            let lat_opt = probe_ip_latency(ip, port, Duration::from_millis(1500)).await;
            match lat_opt {
                Some(lat) => RankedIp {
                    ip,
                    latency: lat,
                    healthy: true,
                },
                None => RankedIp {
                    ip,
                    latency: Duration::from_secs(999),
                    healthy: false,
                },
            }
        });
    }

    let mut results = futures_util::future::join_all(tasks).await;
    // Sort healthy first, then by lowest latency
    results.sort_by(|a, b| {
        b.healthy
            .cmp(&a.healthy)
            .then_with(|| a.latency.cmp(&b.latency))
    });
    results
}
