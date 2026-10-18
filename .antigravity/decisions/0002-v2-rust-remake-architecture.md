# ADR 0002: GECKO v2 — High-Performance Rust Remake

- **Status:** Accepted
- **Datum:** 2026-10-18
- **Kontext:** GECKO v1 läuft als TypeScript/Node.js-Anwendung mit Express, SQLite (better-sqlite3) und Node-Streams. Bei hohen Lasten, vielen gleichzeitigen Verbindungen oder bursty Providern stößt Node.js auf Garbage-Collection-Pausen, Event-Loop-Latenzen und RAM-Overhead.
- **Entscheidung:** GECKO wird von Grund auf in Rust als High-Performance Single-Binary IPTV-Aggregator neu entwickelt.

---

## 1. Workspace- & Crate-Architektur

Ein modularer Cargo-Workspace mit drei spezialisierten Crates:

```
crates/
├── gecko-core/     # Datenmodelle, SQLite WAL Persistence Actor, Xtream API Client, EPG Streaming Parser
├── gecko-proxy/    # Zero-Copy Stream Engine, Broadcast Multiplexer, Live Jitter Buffer, IP-Pinning DNS Resolver, DVR Engine
└── gecko-server/   # Axum Web Server, Xtream/Proxy Router (player_api.php), Admin REST API, Embedded Frontend (rust-embed)
```

### Vorteile der Trennung
- **Isolation der Stream-Engine:** `gecko-proxy` ist unabhängig von HTTP-Routen und Web-Frameworks testbar.
- **Klare Abhängigkeitsgrenzen:** `gecko-core` enthält reine Domänenlogik und SQLite-Zugriff ohne Web-/Proxy-Dependencies.
- **Schnelle inkrementelle Builds:** Änderungen an REST-Endpoints invalidieren nicht den Cache der Stream-Engine.

---

## 2. Stream-Multiplexer & Live-Jitter-Buffer

### Lessons Learned aus v1 (in Rust direkt nativ berücksichtigt)
1. **Zero-Copy Forwarding:**
   - Verwendung von `bytes::Bytes` (referenzgezählte Byte-Slices).
   - Upstream liest Chunks direkt in `Bytes`; Downstream-Clients erhalten geklonte `Bytes`-Handles ohne Heap-Kopien (O(1) Atomic Ref-Count Increment).
2. **1-to-Many Multiplexing:**
   - Pro Live-Kanal verwaltet ein Channel-Hub einen `tokio::sync::broadcast::Sender<Bytes>`.
   - Jeder Downstream-Client abonniert den Kanal über einen `broadcast::Receiver<Bytes>`.
3. **Leaky-Bucket Pacing & Jitter-Buffer:**
   - **Start-Burst Allowance:** Jeder neue Client startet mit initialen 1,2 MB Tokens (`LIVE_BUFFER_INITIAL_BURST_BYTES`), um Zapping-Zeiten < 300 ms zu garantieren.
   - **Initial-Burst Filtration:** Provider senden bei Connect 25–35 MB Vorlauf. Dieser Vorlauf wird als Sicherheitsreserve im Puffer gehalten; die gemessene Senderate ignoriert diesen Vorlauf, um Bitraten-Vergiftung und Puffer-Leerlauf nach ~45 s zu verhindern.
   - **Niemals unter 1.0x:** Der Pacer drosselt niemals unter 1.0x Echtzeit (Video-Decoder laufen fest auf 50 fps). Bei gefülltem Puffer (> 120 % Reserve) wird temporär mit bis zu 1.08x gesendet, um VBR-Spitzen abzubauen.
   - **Starvation-Logging:** Lücken > 1.500 ms werden geloggt.

---

## 3. DNS-Resolver & Socket-Pinning

1. **Multi-A Ranking:**
   - Hostnamen werden zu allen konfigurierten IPv4 A-Records aufgelöst.
   - Latency-Probes messen die RTT zu jeder IP; die schnellste IP wird priorisiert.
2. **IP-Pinning ohne Redirect-Loop:**
   - TCP/TLS-Verbindungen werden gezielt an die gewählte IP gebunden (unter Beibehaltung von SNI und HTTP-`Host`-Header).
   - **Cross-Host-Schutz:** Bei HTTP-302-Redirects auf fremde Hostnames (z. B. Load-Balancer zu Stream-Node `*.qd08v.cc`) wird die Pinning-Bindung sofort aufgehoben und normales DNS verwendet, um Redirect-Schleifen zu verhindern.

---

## 4. SQLite-Persistenz & Concurrency

1. **WAL-Modus:**
   - SQLite läuft durchgehend im Write-Ahead-Logging-Modus (`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`).
2. **Dedicated DB Actor:**
   - Lese-Operationen nutzen einen Pool (`r2d2_sqlite`).
   - Schreib-Operationen laufen über einen dedizierten Tokio-Mpsc-Channel / Actor-Task, sodass langwierige DB-Locks oder Syncs niemals die Tokio-Worker-Threads der Video-Stream-Engine blockieren.

---

## 5. Single-Binary-Frontend-Auslieferung

- Das existierende Vite/React-Frontend wird per `rust-embed` direkt in die finale `gecko`-Binary eingebettet.
- Assets werden mit gzip/brotli Kompression und Cache-Control-Headern ausgeliefert; ungemappte Pfade fallen auf `index.html` (SPA Fallback) zurück.
