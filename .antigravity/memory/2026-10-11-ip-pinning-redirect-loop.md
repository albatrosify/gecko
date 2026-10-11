# IP-Pinning erzeugt Redirect-Endlosschleife bei Cross-Host-Redirects

## Kontext
Quelle „MegaTrial" (`http://ivmxyemi.dupefik.com`, Xtream-Trial) spielte in Gecko-Prod keine Kanäle ab:
`[Proxy] All sources failed for live/...: Maximum number of redirects exceeded (status 502)`.
Streams ohne Redirect (z. B. `live/1474191`) liefen normal.

## Ursache
- Der Provider antwortet auf `http://ivmxyemi.dupefik.com/live/<user>/<pass>/<id>.ts` mit `302` auf einen
  Node-Host (z. B. `http://10361395.qd08v.cc/...?token=...`), der dann `200 video/mp2t` liefert.
- `createIpPinnedAgent` pinnte den TCP-Socket per `lookup`-Override auf die Ziel-IP — für **jeden**
  Hostnamen. Der Redirect-Hop ging dadurch an die IP des Loadbalancers (`43.250.125.30`) mit
  `Host: 10361395.qd08v.cc`.
- Der LB erkannte Host/Token nicht und redirectete erneut auf denselben Node-Host mit zusätzlich
  angehängtem `&token=` (URL wuchs pro Hop ~375 Zeichen, endete im Test in `414 URI Too Long`).
  axios brach nach 21 Hops ab (`Maximum number of redirects exceeded`) → 502.
- Ohne Pinning (normaler DNS) war die Kette `302 → 200` — reproduziert aus dem gecko-Container.

## Lösung
`createIpPinnedAgent(targetIp, pinnedHostname, isHttps)`: Der `lookup` pinnt nur für `pinnedHostname`
(case-insensitiv, abschließender Punkt ignoriert); fremde Hostnames delegieren an `dns.lookup`.
Caller (`server/routes/proxy.ts`, `server/hosts.ts`, `server/multiplexer/stream-hub.ts`,
`measureIpLatency`) übergeben den Hostnamen der Ziel-URL. Regressionstests in
`server/dns-resolver.test.ts` (u. a. axios-Cross-Host-Redirect gegen lokale Server) und
`server/routes/proxy-multi-ip.test.ts`.

## Wiederkehrende Fallstricke
- IPTV-Provider redirecten von einer LB-Domain auf wechselnde Node-Domains (z. B. `*.qd08v.cc`,
  `*.t01m.cc`) mit Token-Query. Jedes Feature, das eine Verbindung auf eine IP festnagelt, muss bei
  Cross-Host-Redirects wieder normales DNS verwenden.
- `Maximum number of redirects exceeded` von axios ist fast immer eine Redirect-*Schleife*, keine
  Provider-Überlastung: die Kette einmal hop-für-hop manuell aufdröseln (Status + `Location`), mit
  und ohne IP-Pinning vergleichen.
- Prod-Deploy: `~/docker/iptv` mountet einzelne `.ts`-Dateien in den `gecko`-Container
  (`docker-compose.yml`, Service `gecko`, z. B. `stream-hub.ts`). Wer `createIpPinnedAgent` ändert,
  muss **alle** gemounteten Caller zusammen deployen — die alte 2-Arg-Signatur würde sonst als
  `(targetIp, isHttps)` interpretiert und Pinning stillschweigend deaktivieren.
