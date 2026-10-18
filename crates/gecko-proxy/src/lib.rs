pub mod connector;
pub mod dns;
pub mod dvr;
pub mod guard;
pub mod jitter;
pub mod multiplexer;

pub use connector::*;
pub use dns::*;
pub use dvr::*;
pub use guard::*;
pub use jitter::*;
pub use multiplexer::*;

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;

    #[tokio::test]
    async fn test_stream_guard_and_jitter() {
        let guard = StreamGuard::new();

        // 1. Initial stream is allowed
        let dec1 = guard.evaluate("src_1", "stream_1", 1, true).await;
        assert_eq!(dec1, GuardDecision::AllowNew);

        // Register it
        guard.register_stream("src_1", "stream_1").await;

        // 2. Same stream request joins existing
        let dec2 = guard.evaluate("src_1", "stream_1", 1, true).await;
        assert_eq!(
            dec2,
            GuardDecision::JoinExisting {
                channel_key: "src_1_stream_1".to_string()
            }
        );

        // 3. Different stream exceeds max_connections=1, blocked
        let dec3 = guard.evaluate("src_1", "stream_2", 1, true).await;
        assert_eq!(
            dec3,
            GuardDecision::BlockConflict {
                source_id: "src_1".to_string(),
                max_cons: 1
            }
        );

        // 4. Test jitter buffer pacing
        let mut jb = JitterBuffer::new(12);
        jb.push(Bytes::from_static(b"0123456789"));
        assert_eq!(jb.buffered_bytes(), 10);
        let slice = jb.pop_slice(true).expect("Should pop slice immediately");
        assert_eq!(slice.as_ref(), b"0123456789");
    }
}
