# Finding: Large Source Sync Event-Loop Starvation & Single-IP DNS Fallback

**Datum:** 2026-10-18  
**Komponenten:** `server/sync.ts`, `server/routes/proxy.ts`

## 1. Event-Loop-Blockade durch VOD Background Sync (185k Items)

### Symptom
- Während einer Live-Übertragung (DEL 2 Eishockey) trat um exakt 18:00:37 Uhr ein scheinbarer Ausfall auf:
  `[StreamHub] Upstream silent for 18518 ms on ... — triggering self-healing reconnect!`
  Gleichzeitig wurde eine Timestamp-Diskontinuität bei der DVR-Aufnahme markiert.
- Der Live-Puffer (10.5 MB) fing die Lücke downstream ab (0 ms Starvation für den Client).

### Ursache
- Um 18:00:20 Uhr startete der Cron-Sync für `Strong (vod)` mit 184.583 VOD-Streams.
- `getChangelog` (Vergleich von zwei 185k-Arrays via Map & Set) und `setSnapshot` (Drizzle `JSON.stringify` eines 185k-Objektarrays + SQLite-Insert eines ~18 MB Blobs) liefen synchron auf dem Haupt-Thread.
- Der Node.js Haupt-Thread war von 18:00:20 bis 18:00:36 für **16 Sekunden komplett blockiert**.
- Der 50ms-Pump-Timer (`pumpChannelBuffer`) und Socket-`data`-Events konnten 16 Sekunden lang nicht verarbeitet werden. StreamHub interpretierte dies fälschlicherweise als `Upstream silent for 18518 ms`.

### Lösung (`server/sync.ts`)
- `getChangelog` wurde asynchronisiert und gibt alle 5.000 Items per `await new Promise(r => setImmediate(r))` der Event-Loop Luft.
- Vor `recordSourceChanges` und vor `setSnapshot` wird ebenfalls explizit der Event-Loop Luft gegeben.
- Resultat: Selbst bei 185k Elementen bleibt der Haupt-Thread reaktionsfähig, `pumpChannelBuffer` feuert verlässlich alle 50 ms.

---

## 2. Multi-A DNS Dynamic Enrichment (`candidateIps`)

### Symptom
- Der Host `operator3.fikar.xyz` besitzt 11 IPv4 A-Records bei OVHcloud.
- Beim Sender `SPORT.DE DEL 2 EVENT 3` brach IP `141.95.102.18` temporär auf ~1.2 Mbps ein.
- Beim In-Place-Reconnect wurde jedoch nie zu einer der 10 anderen IPs rotiert (`rotating to IP` fehlte in den Logs).

### Ursache
- In der Datenbank war für die Quelle vor Einführung des Multi-A-DNS-Features nur die statische Einzel-IP `141.95.102.18` hinterlegt (`matchedHost.resolvedIp`, kein `resolvedIps`-Array).
- In `server/routes/proxy.ts` wurde `candidateIps.push(matchedHost.resolvedIp)` ausgeführt. Da `candidateIps.length === 1` war, wurde der DNS-Lookup `if (candidateIps.length === 0)` übersprungen.
- `candidateIps` enthielt somit nur 1 IP, wodurch `candidateIps.length > 1` beim Reconnect `false` war.

### Lösung (`server/routes/proxy.ts`)
- Bedingung auf `if (candidateIps.length <= 1)` geändert:
  Wenn ein Host weniger als 2 IPs hat, wird `resolveHostIps(hostname)` abgefragt (5-Min-In-Memory-Cache) und alle zusätzlichen DNS-A-Records an `candidateIps` angehängt.
- Resultat: Hosts mit Einzel-IP erhalten zur Laufzeit automatisch alle verfügbaren DNS-IPs und rotieren bei Reconnects/Lags nahtlos durch den Cluster.
