import React, { useEffect, useRef, useState } from 'react';
import { motion, useDragControls } from 'motion/react';
import { X, Play, Pause, Maximize, PictureInPicture, Volume2, VolumeX, Settings2, AlertTriangle, Copy, Check, Download, ChevronDown, Tv } from 'lucide-react';
import mpegts from 'mpegts.js';
import Hls from 'hls.js';
import { downloadStreamM3u, launchExternalPlayer, ExternalPlayerType } from '../playerUtils';

export function VlcIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2L9.5 8H14.5L12 2ZM9 9L7.5 13H16.5L15 9H9ZM7.1 14L5.5 18H18.5L16.9 14H7.1ZM3 19L2 21.5C1.8 22 2.2 22.5 2.8 22.5H21.2C21.8 22.5 22.2 22 22 21.5L21 19H3Z" />
    </svg>
  );
}

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
  const [audioCodecWarning, setAudioCodecWarning] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  const [showPlayerMenu, setShowPlayerMenu] = useState(false);

  // Track states
  const [audioTracks, setAudioTracks] = useState<any[]>([]);
  const [activeAudioTrack, setActiveAudioTrack] = useState(-1);
  const [textTracks, setTextTracks] = useState<any[]>([]);
  const [activeTextTrack, setActiveTextTrack] = useState(-1);
  const [showSettings, setShowSettings] = useState(false);

  const dragControls = useDragControls();

  // Timeout for hiding controls
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const getAbsoluteUrl = () => {
    if (!url) return '';
    return url.startsWith('http://') || url.startsWith('https://')
      ? url
      : `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  const handleOpenExternal = (e?: React.MouseEvent, player: ExternalPlayerType = 'm3u') => {
    if (e) e.stopPropagation();
    const absUrl = getAbsoluteUrl();
    if (!absUrl) return;
    setShowPlayerMenu(false);

    if (player === 'm3u') {
      downloadStreamM3u(absUrl, title);
      setDownloadNotice(title || 'Stream');
      setTimeout(() => setDownloadNotice(null), 5000);
    } else {
      launchExternalPlayer(absUrl, title, player);
    }
  };

  const handleCopyUrl = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const absUrl = getAbsoluteUrl();
    if (!absUrl) return;
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(absUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

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

    setAudioCodecWarning(null);

    // Cleanup previous players
    if (mpegtsPlayerRef.current) {
      if ((mpegtsPlayerRef.current as any)._customRejectionHandler) {
        window.removeEventListener('unhandledrejection', (mpegtsPlayerRef.current as any)._customRejectionHandler);
      }
      try {
        mpegtsPlayerRef.current.destroy();
      } catch (e) {}
      mpegtsPlayerRef.current = null;
    }
    if (hlsPlayerRef.current) {
      try {
        hlsPlayerRef.current.destroy();
      } catch (e) {}
      hlsPlayerRef.current = null;
    }

    setAudioTracks([]);
    setTextTracks([]);
    setActiveAudioTrack(-1);
    setActiveTextTrack(-1);

    const initMpegts = (forceNoAudio = false) => {
      if (mpegts.isSupported()) {
        const player = mpegts.createPlayer({
          type: 'mpegts',
          isLive: true,
          url: url,
          hasAudio: forceNoAudio ? false : undefined, // If true, forces fallback mode without audio
        }, {
          enableStashBuffer: false,
          stashInitialSize: 128,
          lazyLoad: false,
          deferLoadAfterSourceOpen: false,
          liveBufferLatencyChasing: true,
          liveBufferLatencyMaxLatency: 3,
          liveBufferLatencyMinRemain: 1,
        });

        player.on(mpegts.Events.ERROR, (errorType, errorDetail, errorInfo) => {
          console.warn('mpegts error:', errorType, errorDetail, errorInfo);
          if (errorType === mpegts.ErrorTypes.MEDIA_ERROR) {
            console.log('Media error, possibly unsupported codec like AC3.');
            setAudioCodecWarning('Dolby Digital / AC-3 audio is unsupported in this web browser.');
          }
        });

        // Prevent uncaught promise rejections on appendBuffer failures and attempt to recover without audio
        const unhandledRejectionHandler = (e: PromiseRejectionEvent) => {
          if (e.reason && e.reason.name === 'NotSupportedError') {
             e.preventDefault();
             setAudioCodecWarning('Dolby Digital (AC-3/DTS) audio codec is unsupported by browser MediaSource.');
             if (!forceNoAudio) {
               console.warn("Unsupported audio codec detected. Restarting stream with video only...");
               // Clean up the broken player
               if (mpegtsPlayerRef.current) {
                 try { mpegtsPlayerRef.current.destroy(); } catch (e) {}
                 mpegtsPlayerRef.current = null;
               }
               // Remove this specific listener so it doesn't leak or fire twice
               window.removeEventListener('unhandledrejection', unhandledRejectionHandler);
               // Re-initialize without audio
               initMpegts(true);
             }
          }
        };
        window.addEventListener('unhandledrejection', unhandledRejectionHandler);

        // Save reference to handler to remove it later on unmount
        (player as any)._customRejectionHandler = unhandledRejectionHandler;

        mpegtsPlayerRef.current = player;
        player.attachMediaElement(video);
        player.load();
        const playPromise = player.play() as Promise<void> | undefined;
        if (playPromise !== undefined) {
          playPromise.catch(e => console.log('Auto-play blocked', e));
        }
      } else {
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

    const onLoadedMetadata = () => {
      // Native audio tracks (Safari, or Chrome with flag)
      if ((video as any).audioTracks && (video as any).audioTracks.length > 0) {
        const at = (video as any).audioTracks;
        const tracks = [];
        let active = 0;
        for (let i = 0; i < at.length; i++) {
          tracks.push({ id: i, name: at[i].language || at[i].label || `Audio ${i + 1}` });
          if (at[i].enabled) active = i;
        }
        setAudioTracks(tracks);
        setActiveAudioTrack(active);
      }

      // Native text tracks
      if (video.textTracks && video.textTracks.length > 0) {
        const tt = video.textTracks;
        const ttracks = [{ id: -1, name: 'Off' }];
        let active = -1;
        for (let i = 0; i < tt.length; i++) {
          if (tt[i].kind === 'metadata') continue;
          ttracks.push({ id: i, name: tt[i].language || tt[i].label || `Sub ${i + 1}` });
          if (tt[i].mode === 'showing') active = i;
        }
        if (ttracks.length > 1) {
          setTextTracks(ttracks);
          setActiveTextTrack(active);
        }
      }
    };
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('addtrack', onLoadedMetadata); // Sometimes tracks are added after

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('addtrack', onLoadedMetadata);
      if (mpegtsPlayerRef.current) {
        if ((mpegtsPlayerRef.current as any)._customRejectionHandler) {
          window.removeEventListener('unhandledrejection', (mpegtsPlayerRef.current as any)._customRejectionHandler);
        }
        try {
          mpegtsPlayerRef.current.destroy();
        } catch (e) {}
        mpegtsPlayerRef.current = null;
      }
      if (hlsPlayerRef.current) {
        try {
          hlsPlayerRef.current.destroy();
        } catch (e) {}
        hlsPlayerRef.current = null;
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
        <span className="text-white text-xs font-bold truncate pr-3 drop-shadow-md select-none">{title}</span>
        <div className="flex items-center gap-2 relative">
          <div className="flex items-center rounded-lg bg-orange-500/20 border border-orange-500/30 overflow-hidden pointer-events-auto">
            <button
              onClick={(e) => handleOpenExternal(e, 'm3u')}
              className="flex items-center gap-1.5 px-2.5 py-1 hover:bg-orange-500 text-orange-400 hover:text-zinc-950 text-[10px] font-bold transition-all"
              title="Download .m3u to play in VLC / Native Player"
            >
              <VlcIcon size={12} />
              <span>Play in Player</span>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setShowPlayerMenu(!showPlayerMenu); }}
              className="px-1.5 py-1 hover:bg-orange-500 text-orange-400 hover:text-zinc-950 border-l border-orange-500/30 text-[10px] transition-all"
              title="More player options"
            >
              <ChevronDown size={11} />
            </button>
          </div>

          {showPlayerMenu && (
            <div className="absolute top-8 right-8 w-56 bg-zinc-900/95 border border-zinc-700 rounded-xl p-1.5 shadow-2xl backdrop-blur z-50 text-xs flex flex-col gap-1 pointer-events-auto">
              <button
                onClick={(e) => handleOpenExternal(e, 'm3u')}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left hover:bg-zinc-800 text-zinc-200 transition-colors"
              >
                <Download size={13} className="text-orange-400 shrink-0" />
                <div className="flex flex-col">
                  <span className="font-semibold text-[11px] leading-tight">Download M3U Playlist</span>
                  <span className="text-[9px] text-zinc-500">Opens in VLC / Default Player</span>
                </div>
              </button>
              <button
                onClick={(e) => handleOpenExternal(e, 'iina')}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left hover:bg-zinc-800 text-zinc-200 transition-colors"
              >
                <Play size={13} className="text-blue-400 shrink-0" />
                <div className="flex flex-col">
                  <span className="font-semibold text-[11px] leading-tight">Open in IINA</span>
                  <span className="text-[9px] text-zinc-500">macOS player (iina://)</span>
                </div>
              </button>
              <button
                onClick={(e) => handleOpenExternal(e, 'vlc')}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left hover:bg-zinc-800 text-zinc-200 transition-colors"
              >
                <VlcIcon size={13} className="text-orange-400 shrink-0" />
                <div className="flex flex-col">
                  <span className="font-semibold text-[11px] leading-tight">VLC Protocol</span>
                  <span className="text-[9px] text-zinc-500">Requires protocol handler (vlc://)</span>
                </div>
              </button>
              <button
                onClick={(e) => handleOpenExternal(e, 'potplayer')}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left hover:bg-zinc-800 text-zinc-200 transition-colors"
              >
                <Play size={13} className="text-amber-400 shrink-0" />
                <div className="flex flex-col">
                  <span className="font-semibold text-[11px] leading-tight">PotPlayer</span>
                  <span className="text-[9px] text-zinc-500">Windows player (potplayer://)</span>
                </div>
              </button>
              <button
                onClick={handleCopyUrl}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left hover:bg-zinc-800 text-zinc-200 border-t border-zinc-800 mt-0.5 pt-1.5 transition-colors"
              >
                <Copy size={13} className="text-emerald-400 shrink-0" />
                <div className="flex flex-col">
                  <span className="font-semibold text-[11px] leading-tight">{copied ? 'Copied!' : 'Copy Stream URL'}</span>
                  <span className="text-[9px] text-zinc-500">Paste in VLC (Ctrl/Cmd+N)</span>
                </div>
              </button>
            </div>
          )}

          <button
            onClick={onClose}
            className="p-1 rounded-full bg-black/50 text-white hover:bg-red-500 transition-colors pointer-events-auto"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Codec Warning Banner */}
      {audioCodecWarning && (
        <div className="absolute top-11 left-3 right-3 p-2.5 bg-zinc-900/95 border border-amber-500/40 rounded-xl shadow-2xl flex items-center justify-between text-xs z-40 backdrop-blur animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex items-center gap-2 text-amber-400 font-medium truncate pr-2">
            <AlertTriangle size={15} className="shrink-0 text-amber-400" />
            <span className="truncate text-[11px]">{audioCodecWarning}</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={(e) => handleOpenExternal(e, 'm3u')}
              className="px-2.5 py-1 bg-orange-500 hover:bg-orange-400 text-zinc-950 font-bold rounded-lg text-[10px] flex items-center gap-1 transition-all shadow"
              title="Download .m3u to play in VLC / Native Player"
            >
              <VlcIcon size={11} />
              Open in Player (.m3u)
            </button>
            <button
              onClick={handleCopyUrl}
              className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-[10px] flex items-center gap-1 transition-colors"
              title="Copy Stream URL"
            >
              {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={() => setAudioCodecWarning(null)}
              className="p-1 hover:bg-zinc-800 rounded-lg text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}

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
          <button
            onClick={(e) => handleOpenExternal(e, 'm3u')}
            className="text-zinc-400 hover:text-orange-400 transition-colors"
            title="Download .m3u to play in VLC / Native Player"
          >
            <VlcIcon size={16} />
          </button>

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

      {/* Download Notice Toast */}
      {downloadNotice && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 max-w-[90%] px-3 py-2 bg-zinc-900/95 border border-orange-500/40 rounded-xl shadow-2xl flex items-center gap-2.5 text-xs z-50 backdrop-blur pointer-events-auto">
          <Download size={15} className="text-orange-400 shrink-0" />
          <div className="flex flex-col text-left">
            <span className="text-[11px] font-semibold text-zinc-200 truncate max-w-xs">
              Downloaded <code className="text-orange-300 font-mono text-[10px]">{downloadNotice}.m3u</code>
            </span>
            <span className="text-[9px] text-zinc-400">
              Click to open in VLC. Tip: Right-click download in Chrome → &quot;Always open files of this type&quot; for instant launch!
            </span>
          </div>
          <button
            onClick={() => setDownloadNotice(null)}
            className="ml-1 p-0.5 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </motion.div>
  );
}

