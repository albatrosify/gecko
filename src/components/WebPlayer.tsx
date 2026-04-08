import React, { useEffect, useRef, useState } from 'react';
import { motion, useDragControls } from 'motion/react';
import { X, Play, Pause, Maximize, PictureInPicture, Volume2, VolumeX, Settings2 } from 'lucide-react';
import mpegts from 'mpegts.js';
import Hls from 'hls.js';

export interface WebPlayerProps {
  url: string | null;
  title: string;
  onClose: () => void;
}

export function WebPlayer({ url, title, onClose }: WebPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mpegtsPlayerRef = useRef<any>(null);
  const hlsPlayerRef = useRef<Hls | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [showControls, setShowControls] = useState(true);

  // Track states
  const [audioTracks, setAudioTracks] = useState<any[]>([]);
  const [activeAudioTrack, setActiveAudioTrack] = useState(-1);
  const [textTracks, setTextTracks] = useState<any[]>([]);
  const [activeTextTrack, setActiveTextTrack] = useState(-1);
  const [showSettings, setShowSettings] = useState(false);

  const dragControls = useDragControls();

  // Timeout for hiding controls
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 3000);
  };

  const handleMouseLeave = () => {
    if (isPlaying) {
      setShowControls(false);
      setShowSettings(false);
    }
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;

    // Cleanup previous players
    if (mpegtsPlayerRef.current) {
      mpegtsPlayerRef.current.destroy();
      mpegtsPlayerRef.current = null;
    }
    if (hlsPlayerRef.current) {
      hlsPlayerRef.current.destroy();
      hlsPlayerRef.current = null;
    }

    setAudioTracks([]);
    setTextTracks([]);
    setActiveAudioTrack(-1);
    setActiveTextTrack(-1);

    const initMpegts = () => {
      if (mpegts.isSupported()) {
        const player = mpegts.createPlayer({
          type: 'mpegts',
          isLive: true,
          url: url,
        });
        mpegtsPlayerRef.current = player;
        player.attachMediaElement(video);
        player.load();
        const playPromise = player.play() as Promise<void> | undefined;
        if (playPromise !== undefined) {
          playPromise.catch(e => console.log('Auto-play blocked', e));
        }
      } else {
        // Fallback to native if not supported (though rare for modern browsers without MSE)
        video.src = url;
      }
    };

    const initHls = () => {
      if (Hls.isSupported()) {
        const hls = new Hls();
        hlsPlayerRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          const playPromise = video.play();
          if (playPromise !== undefined) {
            playPromise.catch(e => console.log('Auto-play blocked', e));
          }

          // Load audio tracks from HLS
          if (hls.audioTracks && hls.audioTracks.length > 0) {
             setAudioTracks(hls.audioTracks.map((t, i) => ({ id: i, name: t.name || `Audio ${i+1}` })));
             setActiveAudioTrack(hls.audioTrack);
          }

          // Subtitles from HLS
          if (hls.subtitleTracks && hls.subtitleTracks.length > 0) {
            setTextTracks([
              { id: -1, name: 'Off' },
              ...hls.subtitleTracks.map((t, i) => ({ id: i, name: t.name || `Sub ${i+1}` }))
            ]);
            setActiveTextTrack(-1);
          }
        });

        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (event, data) => {
           setActiveAudioTrack(data.id);
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari native HLS
        video.src = url;
        video.addEventListener('loadedmetadata', () => {
          const playPromise = video.play();
          if (playPromise !== undefined) {
            playPromise.catch(e => console.log('Auto-play blocked', e));
          }

          // For Safari native we could try parsing native tracks, but keeping it simple for now
          // audioTracks / textTracks on video element exist but are complex to map
        });
      }
    };

    const ext = url.split('?')[0].split('.').pop()?.toLowerCase();

    if (ext === 'm3u8') {
      initHls();
    } else if (ext === 'ts') {
      initMpegts();
    } else {
      // Direct MP4 or other native formats
      video.src = url;
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise.catch(e => console.log('Auto-play blocked', e));
      }
    }

    // Generic Event Listeners
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      if (mpegtsPlayerRef.current) {
        mpegtsPlayerRef.current.destroy();
      }
      if (hlsPlayerRef.current) {
        hlsPlayerRef.current.destroy();
      }
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    };
  }, [url]);

  if (!url) return null;

  const togglePlay = () => {
    if (videoRef.current) {
      if (videoRef.current.paused) videoRef.current.play();
      else videoRef.current.pause();
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (videoRef.current) {
      videoRef.current.volume = val;
      videoRef.current.muted = val === 0;
      setIsMuted(val === 0);
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      const newMuted = !isMuted;
      videoRef.current.muted = newMuted;
      setIsMuted(newMuted);
      if (newMuted) setVolume(0);
      else setVolume(videoRef.current.volume || 1);
    }
  };

  const toggleFullscreen = () => {
    if (containerRef.current) {
      if (!document.fullscreenElement) {
        containerRef.current.requestFullscreen().catch(err => {
          console.error(`Error attempting to enable fullscreen: ${err.message}`);
        });
      } else {
        document.exitFullscreen();
      }
    }
  };

  const togglePiP = async () => {
    if (videoRef.current && document.pictureInPictureEnabled) {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await videoRef.current.requestPictureInPicture();
      }
    }
  };

  const handleAudioTrackSelect = (id: number) => {
    if (hlsPlayerRef.current) {
       hlsPlayerRef.current.audioTrack = id;
       setActiveAudioTrack(id);
    }
  };

  const handleTextTrackSelect = (id: number) => {
    if (hlsPlayerRef.current) {
       hlsPlayerRef.current.subtitleTrack = id;
       setActiveTextTrack(id);

       if (videoRef.current) {
          // ensure native tracks are off so HLS.js handles it or vice versa
       }
    }
  };

  return (
    <motion.div
      ref={containerRef}
      initial={{ opacity: 0, scale: 0.9, y: 50 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9, y: 50 }}
      drag
      dragControls={dragControls}
      dragListener={false}
      dragMomentum={false}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className="fixed bottom-6 right-6 w-[480px] aspect-video bg-black rounded-xl shadow-2xl z-50 overflow-hidden flex flex-col group border border-zinc-800"
    >
      <video
        ref={videoRef}
        className="w-full h-full object-contain bg-black"
        onClick={togglePlay}
      />

      {/* Top Bar (Draggable) */}
      <div
        className={`absolute top-0 left-0 right-0 p-3 bg-gradient-to-b from-black/80 to-transparent flex items-center justify-between transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0'}`}
        onPointerDown={(e) => dragControls.start(e)}
        style={{ cursor: 'grab' }}
      >
        <span className="text-white text-xs font-bold truncate pr-4 drop-shadow-md select-none">{title}</span>
        <button
          onClick={onClose}
          className="p-1 rounded-full bg-black/50 text-white hover:bg-red-500 transition-colors pointer-events-auto"
        >
          <X size={14} />
        </button>
      </div>

      {/* Settings Panel */}
      {showSettings && (audioTracks.length > 1 || textTracks.length > 0) && (
        <div className="absolute right-4 bottom-16 bg-zinc-900/95 border border-zinc-700 rounded-lg p-3 text-xs shadow-xl backdrop-blur max-h-48 overflow-y-auto w-48 custom-scrollbar">
          {audioTracks.length > 1 && (
            <div className="mb-3">
              <div className="text-zinc-400 font-bold mb-1 uppercase tracking-wider text-[10px]">Audio Track</div>
              {audioTracks.map(t => (
                <button
                   key={`audio-${t.id}`}
                   onClick={() => handleAudioTrackSelect(t.id)}
                   className={`block w-full text-left px-2 py-1 rounded truncate ${activeAudioTrack === t.id ? 'bg-emerald-500/20 text-emerald-400' : 'text-zinc-200 hover:bg-zinc-800'}`}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
          {textTracks.length > 0 && (
            <div>
              <div className="text-zinc-400 font-bold mb-1 uppercase tracking-wider text-[10px]">Subtitles</div>
              {textTracks.map(t => (
                <button
                   key={`text-${t.id}`}
                   onClick={() => handleTextTrackSelect(t.id)}
                   className={`block w-full text-left px-2 py-1 rounded truncate ${activeTextTrack === t.id ? 'bg-emerald-500/20 text-emerald-400' : 'text-zinc-200 hover:bg-zinc-800'}`}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Bottom Controls */}
      <div className={`absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/90 via-black/60 to-transparent flex items-center justify-between transition-opacity duration-300 pointer-events-auto ${showControls ? 'opacity-100' : 'opacity-0'}`}>
        <div className="flex items-center gap-3">
          <button onClick={togglePlay} className="text-white hover:text-emerald-400 transition-colors">
            {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          </button>

          <div className="flex items-center gap-2 group/vol">
            <button onClick={toggleMute} className="text-white hover:text-emerald-400 transition-colors">
              {isMuted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={isMuted ? 0 : volume}
              onChange={handleVolumeChange}
              className="w-16 h-1 bg-zinc-600 rounded-full appearance-none outline-none accent-emerald-500 opacity-0 group-hover/vol:opacity-100 transition-opacity"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          {(audioTracks.length > 1 || textTracks.length > 0) && (
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`transition-colors ${showSettings ? 'text-emerald-400' : 'text-white hover:text-emerald-400'}`}
              title="Settings"
            >
              <Settings2 size={16} />
            </button>
          )}

          {document.pictureInPictureEnabled && (
            <button onClick={togglePiP} className="text-white hover:text-emerald-400 transition-colors" title="Picture in Picture">
              <PictureInPicture size={16} />
            </button>
          )}
          <button onClick={toggleFullscreen} className="text-white hover:text-emerald-400 transition-colors" title="Fullscreen">
            <Maximize size={16} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
