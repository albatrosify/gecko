export type ExternalPlayerType = 'm3u' | 'iina' | 'vlc' | 'potplayer';

/**
 * Generate M3U playlist file content for a given stream URL and title.
 */
export function generateM3uContent(url: string, title: string = 'stream'): string {
  const cleanTitle = (title || 'stream').replace(/[\r\n]/g, ' ').trim() || 'stream';
  return `#EXTM3U\n#EXTINF:-1 tvg-name="${cleanTitle}",${cleanTitle}\n${url}\n`;
}

/**
 * Sanitize a stream title for use as a file name.
 */
export function sanitizeFilename(title: string = 'stream'): string {
  const clean = (title || 'stream').replace(/[\r\n]/g, ' ').trim() || 'stream';
  return clean.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'stream';
}

/**
 * Format an external player URL scheme or return null if using file download.
 */
export function getPlayerSchemeUrl(url: string, player: ExternalPlayerType): string | null {
  if (!url) return null;
  const absUrl = url.startsWith('http://') || url.startsWith('https://')
    ? url
    : (typeof window !== 'undefined' ? `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}` : url);

  switch (player) {
    case 'iina':
      return `iina://weblink?url=${encodeURIComponent(absUrl)}`;
    case 'vlc':
      return `vlc://${absUrl}`;
    case 'potplayer':
      return `potplayer://${absUrl}`;
    case 'm3u':
    default:
      return null;
  }
}

/**
 * Downloads a single-stream .m3u playlist file that directly opens in VLC,
 * IINA, QuickTime, or whatever native media player is registered on the device.
 */
export function downloadStreamM3u(url: string, title: string = 'stream') {
  if (!url || typeof document === 'undefined') return;
  const absUrl = url.startsWith('http://') || url.startsWith('https://')
    ? url
    : `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`;

  const safeFilename = sanitizeFilename(title);
  const m3uContent = generateM3uContent(absUrl, title);

  const blob = new Blob([m3uContent], { type: 'audio/x-mpegurl;charset=utf-8' });
  const downloadUrl = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = `${safeFilename}.m3u`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(downloadUrl);
}

/**
 * Launch an external media player using either an .m3u file download (default / universal)
 * or a custom URL scheme (iina://, vlc://, potplayer://).
 */
export function launchExternalPlayer(url: string, title: string = 'stream', player: ExternalPlayerType = 'm3u') {
  if (!url) return;
  if (player === 'm3u') {
    downloadStreamM3u(url, title);
    return;
  }

  const schemeUrl = getPlayerSchemeUrl(url, player);
  if (schemeUrl && typeof window !== 'undefined') {
    window.location.href = schemeUrl;
  }
}
