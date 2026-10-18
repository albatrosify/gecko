use bytes::Bytes;
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use tracing::{debug, warn};

pub const LIVE_BUFFER_PUMP_MS: u64 = 50;
pub const LIVE_SLICE_BYTES: usize = 64_000;
pub const LIVE_BUFFER_DEFAULT_RESERVE_S: u64 = 12;
pub const LIVE_BUFFER_INITIAL_BURST_BYTES: f64 = 1_200_000.0;
pub const LIVE_BUFFER_FALLBACK_RATE_BPS: f64 = 800_000.0; // 800 KB/s = 6.4 Mbps
pub const LIVE_BUFFER_MAX_STREAM_RATE_BPS: f64 = 2_500_000.0; // 20 Mbps
pub const LIVE_BUFFER_RATE_WINDOW_S: u64 = 60;
pub const LIVE_BUFFER_RATE_WARMUP_S: u64 = 3;
pub const LIVE_BUFFER_RATE_MAX_GAP_S: u64 = 12;
pub const LIVE_BUFFER_MAX_BYTES: usize = 64_000_000; // 64 MB
pub const LIVE_BUFFER_STARVE_LOG_MS: u64 = 1_500;

#[derive(Debug, Clone)]
struct BufferedChunk {
    data: Bytes,
}

#[derive(Debug, Clone)]
struct RateBucket {
    bytes: usize,
    at: Instant,
}

pub struct JitterBuffer {
    chunks: VecDeque<BufferedChunk>,
    buffered_bytes: usize,
    reserve_seconds: u64,
    tokens: f64,
    max_tokens: f64,
    rate_buckets: VecDeque<RateBucket>,
    in_initial_burst: bool,
    initial_burst_bytes: usize,
    stream_started_at: Instant,
    last_chunk_at: Instant,
    last_pump_at: Instant,
    starved_since: Option<Instant>,
}

impl JitterBuffer {
    pub fn new(reserve_seconds: u64) -> Self {
        let now = Instant::now();
        Self {
            chunks: VecDeque::new(),
            buffered_bytes: 0,
            reserve_seconds,
            tokens: LIVE_BUFFER_INITIAL_BURST_BYTES,
            max_tokens: LIVE_BUFFER_INITIAL_BURST_BYTES * 2.0,
            rate_buckets: VecDeque::new(),
            in_initial_burst: true,
            initial_burst_bytes: 0,
            stream_started_at: now,
            last_chunk_at: now,
            last_pump_at: now,
            starved_since: None,
        }
    }

    pub fn push(&mut self, chunk: Bytes) {
        let now = Instant::now();
        let chunk_len = chunk.len();

        // 1. Memory ceiling check: drop oldest if exceeding 64MB
        while self.buffered_bytes + chunk_len > LIVE_BUFFER_MAX_BYTES {
            if let Some(old) = self.chunks.pop_front() {
                self.buffered_bytes = self.buffered_bytes.saturating_sub(old.data.len());
            } else {
                break;
            }
        }

        // 2. Track initial connect burst
        if self.in_initial_burst {
            self.initial_burst_bytes += chunk_len;
            let elapsed_s = now.duration_since(self.stream_started_at).as_secs();
            let gap_since_last = now.duration_since(self.last_chunk_at);

            // If we observed a pause > 1.5s after 3s of streaming or after 12s total
            if (elapsed_s >= 3 && gap_since_last >= Duration::from_millis(1500)) || elapsed_s >= 12
            {
                debug!(
                    "Initial connect burst completed ({} MB). Resetting rate buckets.",
                    self.initial_burst_bytes / 1_000_000
                );
                self.in_initial_burst = false;
                self.rate_buckets.clear();
            }
        }

        // 3. Record rate measurement
        if !self.in_initial_burst {
            self.rate_buckets.push_back(RateBucket {
                bytes: chunk_len,
                at: now,
            });
            self.prune_rate_buckets(now);
        }

        self.chunks.push_back(BufferedChunk {
            data: chunk,
        });
        self.buffered_bytes += chunk_len;
        self.last_chunk_at = now;
        self.starved_since = None;
    }

    fn prune_rate_buckets(&mut self, now: Instant) {
        let cutoff = now - Duration::from_secs(LIVE_BUFFER_RATE_WINDOW_S);
        while let Some(front) = self.rate_buckets.front() {
            if front.at < cutoff {
                self.rate_buckets.pop_front();
            } else {
                break;
            }
        }
    }

    /// Computes the effective nominal bitrate based on measured data rate.
    pub fn estimated_bitrate_bps(&self) -> f64 {
        if self.in_initial_burst || self.rate_buckets.len() < 5 {
            return LIVE_BUFFER_FALLBACK_RATE_BPS;
        }

        let total_bytes: usize = self.rate_buckets.iter().map(|b| b.bytes).sum();
        let oldest = self.rate_buckets.front().unwrap().at;
        let newest = self.rate_buckets.back().unwrap().at;
        let span_secs = newest.duration_since(oldest).as_secs_f64();

        if span_secs < LIVE_BUFFER_RATE_WARMUP_S as f64 {
            return LIVE_BUFFER_FALLBACK_RATE_BPS;
        }

        // Cap gaps to prevent depressing rate below real-time
        let effective_span = span_secs.min(LIVE_BUFFER_RATE_WINDOW_S as f64);
        let measured_rate = total_bytes as f64 / effective_span;

        measured_rate.clamp(
            LIVE_BUFFER_FALLBACK_RATE_BPS,
            LIVE_BUFFER_MAX_STREAM_RATE_BPS,
        )
    }

    /// Pumps tokens and returns the next slice (up to 64 KB) if tokens allow.
    pub fn pop_slice(&mut self, has_subscribers: bool) -> Option<Bytes> {
        let now = Instant::now();
        let elapsed_secs = now.duration_since(self.last_pump_at).as_secs_f64();
        self.last_pump_at = now;

        // If pacing is disabled (reserve == 0), pass-through immediately
        if self.reserve_seconds == 0 {
            return self.pop_immediate();
        }

        let base_rate = self.estimated_bitrate_bps();
        let reserve_bytes = (base_rate * self.reserve_seconds as f64) as usize;

        // Dynamic multiplier:
        // NEVER pace below 1.0x!
        // If buffer is healthy (> 1.2 * reserve), allow up to 1.08x to drain surplus
        let rate_multiplier = if self.buffered_bytes > (reserve_bytes as f64 * 1.2) as usize {
            1.08
        } else {
            1.00
        };

        // Add tokens generated in this pump interval
        let tokens_added = base_rate * rate_multiplier * elapsed_secs;
        self.tokens = (self.tokens + tokens_added).min(self.max_tokens);

        // Check starvation
        if self.buffered_bytes == 0 {
            if has_subscribers {
                let starved_dur = match self.starved_since {
                    Some(s) => now.duration_since(s),
                    None => {
                        self.starved_since = Some(now);
                        Duration::ZERO
                    }
                };
                if starved_dur >= Duration::from_millis(LIVE_BUFFER_STARVE_LOG_MS) {
                    warn!(
                        "⚠️ Downstream starved for {} ms",
                        starved_dur.as_millis()
                    );
                }
            }
            return None;
        }

        // Check if we have enough tokens for at least a partial slice
        if self.tokens < 1000.0 {
            return None;
        }

        let allowed_bytes = (self.tokens as usize).min(LIVE_SLICE_BYTES);
        let slice = self.extract_slice(allowed_bytes);
        if let Some(ref s) = slice {
            self.tokens -= s.len() as f64;
        }
        slice
    }

    fn pop_immediate(&mut self) -> Option<Bytes> {
        if let Some(mut front) = self.chunks.pop_front() {
            if front.data.len() <= LIVE_SLICE_BYTES {
                self.buffered_bytes = self.buffered_bytes.saturating_sub(front.data.len());
                Some(front.data)
            } else {
                let slice = front.data.split_to(LIVE_SLICE_BYTES);
                self.buffered_bytes = self.buffered_bytes.saturating_sub(slice.len());
                self.chunks.push_front(front);
                Some(slice)
            }
        } else {
            None
        }
    }

    fn extract_slice(&mut self, max_bytes: usize) -> Option<Bytes> {
        let front = self.chunks.front_mut()?;
        if front.data.len() <= max_bytes {
            let chunk = self.chunks.pop_front().unwrap();
            self.buffered_bytes = self.buffered_bytes.saturating_sub(chunk.data.len());
            Some(chunk.data)
        } else {
            let slice = front.data.split_to(max_bytes);
            self.buffered_bytes = self.buffered_bytes.saturating_sub(slice.len());
            Some(slice)
        }
    }

    pub fn buffered_bytes(&self) -> usize {
        self.buffered_bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_jitter_buffer_initial_burst() {
        let mut jb = JitterBuffer::new(12);
        assert_eq!(jb.tokens, LIVE_BUFFER_INITIAL_BURST_BYTES);

        // Push 1 MB of test data
        let chunk = Bytes::from(vec![0u8; 1_000_000]);
        jb.push(chunk);

        // Instant pop should yield up to LIVE_SLICE_BYTES immediately thanks to token grant
        let slice = jb.pop_slice(true).expect("Should release slice immediately");
        assert_eq!(slice.len(), LIVE_SLICE_BYTES);
    }
}
