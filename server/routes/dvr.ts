import { Router } from 'express';
import fs from 'fs';
import { requireAuth, requireAuthOrQuery, type AuthRequest } from '../auth.ts';
import { dvrRecorder } from '../dvr/recorder.ts';
import { log } from '../logger.ts';
import { serveRecordingFile } from '../dvr/playback';

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

      const safeFilename = `${recording.streamName.replace(/[^a-zA-Z0-9_-]/g, '_')}_${id}.ts`;
      res.setHeader('Content-Disposition', `${isDownload ? 'attachment' : 'inline'}; filename="${safeFilename}"`);

      serveRecordingFile(req, res, {
        filePath,
        isGrowing: recording.status === 'recording',
        isStillGrowing: () => dvrRecorder.getRecordingById(id)?.status === 'recording',
      });
    } catch (err: any) {
      log(`[DVR] Error streaming recording ${id}: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
