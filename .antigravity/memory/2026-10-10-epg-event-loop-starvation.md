# EPG Event-Loop Starvation & Disk-Caching (`/xmltv.php`)

**Datum:** 2026-10-10  
**Symptom:** Sporadisches Ruckeln / Buffern bei Live-Streams auf TiviMate, obwohl der VPS über Gigabit-Bandbreite verfügt und der Stream-Jitter-Buffer intakt war.  
**Ursache:** Single-Threaded Event Loop Starvation durch synchrone CPU-Operationen in `/xmltv.php`.

---

### Was ist passiert?
1. Um 18:43:35 Uhr hat sich ein zweiter Client (`mama` auf TiviMate) verbunden. TiviMate ruft beim Start automatisch `GET /xmltv.php?username=...&password=...` ab.
2. In `server/routes/proxy.ts` gab es für `/xmltv.php` **keinerlei serverseitiges Caching**.
3. Gecko lud bei jedem Request das vollständige EPG vom Upstream-Provider herunter (~100 MB XMLTV).
4. Das Entpacken geschah mit `zlib.gunzipSync(data)` direkt auf dem Node.js Haupt-Thread.
5. Anschließend liefen teure Regex-Operationen (`xml.replace(/&(?!(?:amp.../gi)` und `proxyXmlIcons`) auf dem 100-MB-String.
6. Der Request blockierte den Node.js Haupt-Thread für bis zu 76 Sekunden.
7. Da Node.js single-threaded ist, konnte währenddessen der Pumping-Loop für Live-Streams (`pumpChannelBuffer` in `stream-hub.ts`) keine Pakete an die Clients schreiben. Sockets froren ein, der lokale TiviMate-Puffer lief leer und es begann zu buffern.

---

### Lösung (`server/epg-service.ts`)
1. **Pre-compressed Disk-Cache (`.xml.gz`)**:
   - EPG wird in `data/epg-cache/epg_<playlistId>.xml.gz` gespeichert.
   - TTL: 6 Stunden fresh, bis 24 Stunden stale-while-revalidate.
2. **Zero-Copy Streaming**:
   - Wenn ein Client (wie TiviMate) `/xmltv.php` mit `Accept-Encoding: gzip` anfragt, wird die fertige Datei per `fs.createReadStream().pipe(res)` mit `Content-Encoding: gzip` direkt gestreamt.
   - Dauer: **< 10 Millisekunden**, **0% CPU**, **0 Millisekunden Event-Loop-Blockade**.
3. **Stale-While-Revalidate**:
   - Ist der Cache zwischen 6 und 24 Stunden alt, wird sofort die bestehende Datei ausgeliefert und im Hintergrund (`setImmediate`) asynchron aktualisiert.
4. **Asynchrones Entpacken**:
   - Alle `gunzipSync`-Aufrufe wurden durch asynchrone `gunzipAsync` (libuv C++ Threadpool) ersetzt, damit Hintergrund-Builds die Event-Loop niemals aushungern.
5. **In-Flight Deduplizierung**:
   - Parallele Anfragen für dieselbe Playlist teilen sich ein einziges Build-Promise.
