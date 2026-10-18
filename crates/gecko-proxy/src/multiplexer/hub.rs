use crate::connector::create_pinned_client;
use crate::dns::DnsResolver;
use crate::jitter::JitterBuffer;
use bytes::Bytes;
use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, RwLock};
use tokio::time::sleep;
use tracing::{error, info, warn};

pub const BROADCAST_CAPACITY: usize = 1024;
pub const RECONNECT_BACKOFF_SECS: [u64; 4] = [2, 4, 8, 15];

pub struct ChannelHandle {
    pub sender: broadcast::Sender<Bytes>,
}

#[derive(Clone)]
pub struct StreamHub {
    channels: Arc<RwLock<HashMap<String, ChannelHandle>>>,
    dns: DnsResolver,
    reserve_seconds: u64,
}

impl StreamHub {
    pub fn new(reserve_seconds: u64) -> Self {
        Self {
            channels: Arc::new(RwLock::new(HashMap::new())),
            dns: DnsResolver::new(),
            reserve_seconds,
        }
    }

    /// Subscribes to an existing live channel or spawns an upstream worker if not running.
    pub async fn subscribe(
        &self,
        channel_key: &str,
        upstream_url: &str,
        preferred_ip: Option<Ipv4Addr>,
    ) -> broadcast::Receiver<Bytes> {
        let mut channels = self.channels.write().await;

        if let Some(ch) = channels.get(channel_key) {
            info!("Attaching downstream subscriber to existing channel '{}'", channel_key);
            return ch.sender.subscribe();
        }

        info!("Spawning new upstream pipeline for channel '{}'", channel_key);
        let (sender, receiver) = broadcast::channel(BROADCAST_CAPACITY);
        channels.insert(
            channel_key.to_string(),
            ChannelHandle {
                sender: sender.clone(),
            },
        );

        // Spawn channel worker task
        let hub_clone = self.clone();
        let key_clone = channel_key.to_string();
        let url_clone = upstream_url.to_string();
        let reserve_secs = self.reserve_seconds;

        tokio::spawn(async move {
            hub_clone
                .run_channel_loop(key_clone, url_clone, preferred_ip, sender, reserve_secs)
                .await;
        });

        receiver
    }

    async fn run_channel_loop(
        &self,
        channel_key: String,
        upstream_url: String,
        preferred_ip: Option<Ipv4Addr>,
        sender: broadcast::Sender<Bytes>,
        reserve_secs: u64,
    ) {
        let (host, port) = DnsResolver::extract_hostname_and_port(&upstream_url);
        let mut attempt = 0;

        loop {
            // Check if any subscribers are still listening
            if sender.receiver_count() == 0 {
                // Wait short idle period before killing
                sleep(Duration::from_secs(3)).await;
                if sender.receiver_count() == 0 {
                    info!("Channel '{}' has 0 subscribers, terminating upstream task", channel_key);
                    break;
                }
            }

            // Select IP for connection
            let target_ip = if let Some(ip) = preferred_ip {
                ip
            } else {
                let resolved = self.dns.resolve_host_ips(&host).await;
                match resolved.first() {
                    Some(&ip) => ip,
                    None => {
                        error!("Failed to resolve IP for host '{}'", host);
                        sleep(Duration::from_secs(2)).await;
                        continue;
                    }
                }
            };

            let client = create_pinned_client(target_ip, &host, port);
            info!(
                "Connecting to upstream for channel '{}' at {} ({})",
                channel_key, upstream_url, target_ip
            );

            match client.get(&upstream_url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    info!("Upstream connected successfully for '{}' (HTTP {})", channel_key, resp.status());
                    attempt = 0; // reset reconnect counter

                    let mut stream = resp.bytes_stream();
                    let mut jitter = JitterBuffer::new(reserve_secs);
                    let mut pump_interval = tokio::time::interval(Duration::from_millis(crate::jitter::LIVE_BUFFER_PUMP_MS));

                    use futures_util::StreamExt;

                    loop {
                        tokio::select! {
                            // Upstream chunk arrived
                            chunk_res = stream.next() => {
                                match chunk_res {
                                    Some(Ok(chunk)) => {
                                        jitter.push(chunk);
                                    }
                                    Some(Err(e)) => {
                                        warn!("Upstream stream error for '{}': {}", channel_key, e);
                                        break; // triggers reconnect
                                    }
                                    None => {
                                        warn!("Upstream stream reached EOF for '{}'", channel_key);
                                        break; // triggers reconnect
                                    }
                                }
                            }
                            // Pacing interval timer: pump jitter buffer
                            _ = pump_interval.tick() => {
                                let has_subs = sender.receiver_count() > 0;
                                while let Some(slice) = jitter.pop_slice(has_subs) {
                                    // Zero-copy broadcast forwarding
                                    let _ = sender.send(slice);
                                }

                                if !has_subs {
                                    info!("All subscribers disconnected from '{}', tearing down", channel_key);
                                    let mut channels = self.channels.write().await;
                                    channels.remove(&channel_key);
                                    return;
                                }
                            }
                        }
                    }
                }
                Ok(bad_resp) => {
                    warn!("Upstream returned status {} for '{}'", bad_resp.status(), channel_key);
                }
                Err(e) => {
                    warn!("Upstream connection failed for '{}': {}", channel_key, e);
                }
            }

            // Self-healing reconnect backoff
            if sender.receiver_count() == 0 {
                break;
            }
            let backoff = RECONNECT_BACKOFF_SECS.get(attempt).copied().unwrap_or(15);
            warn!(
                "Upstream disconnected for '{}'. Reconnecting in {}s (attempt {})...",
                channel_key, backoff, attempt + 1
            );
            sleep(Duration::from_secs(backoff)).await;
            attempt = (attempt + 1).min(RECONNECT_BACKOFF_SECS.len() - 1);
        }

        // Cleanup channel from registry
        let mut channels = self.channels.write().await;
        channels.remove(&channel_key);
    }

    pub async fn active_channels_count(&self) -> usize {
        self.channels.read().await.len()
    }
}
