# DVR Recording Timestamp Repair & Safe Backup Retention

## Problem

Live IPTV stream recordings dumped directly as raw MPEG-TS chunks suffered from phantom 26.5-hour duration indicators in players like TiviMate, VLC, and ExoPlayer, even when the real wall-clock broadcast was only 3.5 hours.

### Root Cause
1. **33-bit PTS Clock**: In MPEG-TS (ISO 13818-1), Presentation Time Stamps (PTS) run at 90 kHz on a 33-bit counter. The maximum value before overflow is $2^{33} / 90{,}000 \approx 26.512\text{ hours}$.
2. **Upstream In-Place Reconnects**: When `StreamHub` executes self-healing reconnects to recover from upstream dead-air silence gaps, the new connection from the IPTV provider CDN starts with its own PTS counter (often near 0).
3. **Rollover Illusion**: When a player encounters a backward timestamp jump (e.g. from 1.82h down to 0.07h), it applies 33-bit modulo arithmetic $(P_2 - P_1) \pmod{2^{33}}$, treating it as a rollover and adding ~24.77 hours to the timeline, arriving at ~26.58 hours.

## Solution

Implemented a non-destructive, lossless remux repair pipeline in Gecko:
1. **Lossless Remux**: `ffmpeg -err_detect ignore_err -fflags +genpts+discardcorrupt -i input.ts -c copy output.ts`. FFmpeg detects timestamp discontinuities, aligns stream offsets, and rebuilds continuous monotonic timestamps from 0:00:00 without re-encoding audio or video.
2. **Automatic Detection**: When `StreamHub` reconnects on a channel with an active DVR recording, it flags `session.hasDiscontinuity = true`. When completed, the recording is marked with `needsRepair: true`, displaying a warning badge `⚠️ Timestamp issue` in the UI.
3. **Original Backup Retention**: Before replacing the recording with the repaired file, the original is preserved at `<filePath>.orig.ts`.
4. **Revert Capability**: If a repaired file exhibits issues, the user can click "Revert" (`POST /api/dvr/recordings/:id/revert`) to restore the original backup.
5. **Auto-Pruning**: Backups carry `backupExpiresAt` (default 3 days, configurable via `DVR_BACKUP_RETENTION_DAYS`). Expired backups are safely unlinked via `dvrRecorder.pruneExpiredBackups()`, which runs on server startup and every 6 hours. The repaired recording is never touched.

## Key Endpoints
* `POST /api/dvr/recordings/:id/repair`
* `POST /api/dvr/recordings/:id/revert`
