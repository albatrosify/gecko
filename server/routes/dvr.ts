import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { requireAuth, requireAuthOrQuery, type AuthRequest } from '../auth.ts';
import { dvrRecorder } from '../dvr/recorder.ts';
import { log } from '../logger.ts';

export function createDvrRouter() {
  const router = Router();

  // List all recordings
  router.get('/recordings', requireAuth, async (_req, res) => {
    try {
      const recordings = dvrRecorder.getAllRecordings();
      res.json(recordings);
    } catch (err: any) {
      log(`[DVR] Failed to list recordings: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Start recording an active live connection ("Record Now")
  router.post('/record-now', requireAuth, async (req: any, res) => {
    const { connectionId } = req.body || {};
    if (!connectionId) {
      return res.status(400).json({ error: 'connectionId is required' });
    }

    try {
      const userId = req.user?.id || 'admin';
      const recording = await dvrRecorder.startLiveRecordingFromConnection(connectionId, userId);
      res.json({ success: true, recording });
    } catch (err: any) {
      log(`[DVR] Failed to start live recording for connection ${connectionId}: ${err.message}`);
      res.status(400).json({ error: err.message });
    }
  });

  // Stop an active recording
  router.post('/recordings/:id/stop', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
      const recording = await dvrRecorder.stopRecording(id);
      res.json({ success: true, recording });
    } catch (err: any) {
      log(`[DVR] Failed to stop recording ${id}: ${err.message}`);
      res.status(400).json({ error: err.message });
    }
  });

  // Delete a recording
  router.delete('/recordings/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
      const deleted = await dvrRecorder.deleteRecording(id);
      if (deleted) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Recording not found' });
      }
    } catch (err: any) {
      log(`[DVR] Failed to delete recording ${id}: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Stream / download recording file with Range request support
  router.get('/recordings/:id/stream', requireAuthOrQuery, async (req: AuthRequest, res) => {
    const { id } = req.params;
    const isDownload = req.query.download === 'true';

    try {
      const recording = dvrRecorder.getRecordingById(id);
      if (!recording || !recording.filePath || !fs.existsSync(recording.filePath)) {
        return res.status(404).json({ error: 'Recording file not found on disk' });
      }

      const filePath = recording.filePath;
      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const range = req.headers.range;

      const safeFilename = `${recording.streamName.replace(/[^a-zA-Z0-9_-]/g, '_')}_${id}.ts`;

      if (isDownload) {
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
      } else {
        res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
      }

      // Range request support for seeking in HTML5 video
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': 'video/mp2t',
        });
        file.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'video/mp2t',
          'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(filePath).pipe(res);
      }
    } catch (err: any) {
      log(`[DVR] Error streaming recording ${id}: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
