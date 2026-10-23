# Toter Primary-Host kostet 15–30 s pro Anfrage

**Datum:** 2026-10-23 — Vorfall: „Tivione reagiert nicht" (Playlist `moritz`)

## Symptom

Live-Requests brauchten **30,6 s bis zum ersten Byte**, danach lief der Stream
normal. Im Log:

```
Host http://line.tivione2.cv (IP: 172.67.190.232) error for live/1149629:
timeout of 15000ms exceeded, trying next candidate IP...
```

## Befund

- `line.tivione2.cv` (Primary, `hosts[].order = 0`): TCP-Connect in 2–28 ms
  (Cloudflare nimmt an), aber **nie eine HTTP-Antwort** — auch `/` läuft ins
  Timeout. Origin hinter dem CDN tot. Statistik: 146 Fehlschläge bei 267 Nutzungen.
- `line.one-ott.xyz` und `line.tivi-ott.net`: 0,29 s bzw. 0,36 s bis 200, streamen.
- Durch Gecko: `ttfb = 30,6 s` = **2 Cloudflare-IPs × 15 s Handshake-Timeout**,
  bevor der nächste Host überhaupt probiert wurde.

## Ursache

`getOrderedHosts()` sortierte **nur** nach „Primary zuerst, dann `order`" — die
aufgezeichneten Fehlschläge wurden ignoriert. Ein toter Primary stand damit bei
jeder Anfrage vorne. Verstärkt durch die IP-Rotation: bei einem CDN-Host zeigen
alle A-Records auf denselben Origin, jeder zusätzliche Versuch ist garantiert
genauso tot und kostet nochmal das volle Timeout.

## Fix (2026-10-23)

1. **Gesundheitsbewusste Sortierung** in `hosts.ts`: EMA-Score `health`
   (`nextHostHealth`, α = 0,2) pro Host, geflusht mit den Nutzungsstatistiken.
   `health < 0.6` → Host rutscht hinter die gesunden (`isHostDemoted`). Nach
   **10 min ohne Fehler** (Probation) wird er wieder normal behandelt, sonst
   könnte sich ein genesener Host nie zurückmelden, weil er nie probiert wird.
   Primary- und `order`-Priorität gelten weiter — aber nur unter gleich gesunden
   Hosts.
2. **Kein IP-Failover bei CDN-Hosts** (`proxy.ts`): Ist `networkType === 'cdn'`
   bzw. `cdnProvider` bekannt und läuft der erste Versuch in einen Timeout, wird
   der Rest der Edge-IPs übersprungen und direkt der nächste Host probiert.

## Betriebs-Konsequenz

Die **Primary-URL (`sources.url`)** ist immer Teil der Host-Liste —
`normalizeHosts()` injiziert sie. Einen toten Host aus `hosts[]` zu löschen
reicht also nicht; die URL muss umgestellt werden. Am 2026-10-23 auf
`http://line.tivi-ott.net` geändert → ttfb 30,6 s → 0,44 s.
