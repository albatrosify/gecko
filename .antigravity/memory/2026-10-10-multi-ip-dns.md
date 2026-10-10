# Multi-A DNS Resolution, IP Pinning & Failover

## Kontext
Viele Upstream-IPTV-Provider (wie z. B. `operator3.fikar.xyz`) hinterlegen hinter einer einzigen Domain mehrere DNS-A-Records (im Live-Test auf OVH: 11 dedizierte IP-Adressen).
Standardmäßig nutzt Node.js (`getaddrinfo` ohne `{ all: true }`) ausschließlich die erste vom System-Resolver zurückgegebene IP. Bei Round-Robin-DNS wechseln nachfolgende Verbindungen unkontrolliert, während bei Ausfall einer IP Standard-Requests abbrechen, anstatt die restlichen 10 gesunden IPs zu probieren.

Direktes Verwenden von Roh-IPs in URLs bricht jedoch:
1. **HTTPS / TLS SNI**: Wildcard-Zertifikate (z. B. `*.fikar.xyz`) scheitern an `ERR_TLS_CERT_ALTNAME_INVALID`, wenn keine SNI (`servername: hostname`) übergeben wird.
2. **HTTP Virtual Hosting**: Reverse Proxies (Nginx) verwerfen Requests oder leiten auf Default-Serverblöcke um, wenn der `Host`-Header fehlt.
3. **Cluster-Dynamik**: Provider tauschen gemiedene oder überlastete IPs dynamisch im DNS aus.

## Lösung
1. **`server/dns-resolver.ts`**:
   - `resolveHostIps(hostname)`: Löst alle IPv4-A-Records via `dns.promises.resolve4` (Fallback `lookup`) auf und puffert sie mit 5-Minuten-TTL.
   - `createIpPinnedAgent(targetIp, isHttps)`: Erzeugt `http.Agent` / `https.Agent` mit benutzerdefiniertem `lookup`.
     - **Wichtig für Node 20+ Happy Eyeballs**: Wenn `options.all === true`, muss `callback(null, [{ address: targetIp, family: 4 }])` zurückgegeben werden; andernfalls `callback(null, targetIp, 4)`.
     - Dadurch pinnt der TCP-Socket exakt auf `targetIp`, während URL, `Host`-Header und TLS SNI der Originaldomain vollständig intakt bleiben.
   - `rankHostIps(hostname, port, isHttps)`: Ermittelt die Latenzen aller Cluster-IPs parallel und sortiert nach Antwortzeit aufsteigend.
2. **`server/hosts.ts`**:
   - `detectHostNetwork` und `benchmarkSourceHosts` erkennen Multi-IP-Domains, ranken die Kandidaten und speichern die schnellste gesunde IP als `resolvedIp` sowie den gesamten Pool in `resolvedIps` & `ipCount`.
3. **`server/routes/proxy.ts`**:
   - `handleStreamProxy` probiert bei Multi-IP-Hosts zuerst die schnellste gesunde IP. Schlägt diese fehl (HTTP >= 400 oder Timeout), wird transparent zur nächsten Kandidaten-IP desselben Hosts gewechselt, bevor auf alternative Host-URLs zurückgegriffen wird.
4. **`server/multiplexer/stream-hub.ts`**:
   - Bei In-Place Reconnects (`reconnectChannel`) nach Upstream-Pausen/Gaps rotiert StreamHub zur nächsten gesunden Kandidaten-IP im Pool (`currentIpIndex`), wodurch hängende Edge-Server automatisch umgangen werden.
5. **UI (`src/components/index.tsx`)**:
   - Zeigt neben dem `Direct`-Badge eine `[X IPs]`-Pille an. Der Tooltip listet alle Cluster-IPs mit gemessenen Latenzen (z. B. `31ms`, `32ms`, `93ms`) und markiert die aktive IP.
