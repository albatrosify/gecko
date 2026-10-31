# HTTP 409 vom Upstream = Account-Slot belegt, nicht Host kaputt

**Datum:** 2026-10-23 — Vorfall: alle Streams einer Quelle lieferten 503

## Symptom

Nach einem Container-Neustart lieferte eine Quelle (Xtream-Panel mit
`max_connections: 1`) für **jeden** Sender `503` nach exakt 10,1 s, für VOD
teils `409`. Andere Quellen auf derselben Kiste liefen normal, `player_api.php`
und Sync antworteten sauber (`auth:1`, `active_cons:0`).

Der Body des 409 war der Schlüssel:

```json
{"error":{"type":0,"code":6,"message":"a newer request of the user took the slot first"}}
```

Das ist **nicht** „Host down", sondern die Slot-Verwaltung des Panels: pro Account
existiert genau ein Stream-Slot, und die *neuere* Anfrage gewinnt ihn, die ältere
bekommt 409.

## Warum das mit IP-Failover eskaliert

`server/routes/proxy.ts` hat pro Host eine Kandidaten-IP-Liste und rotierte bei
jedem Fehler weiter. Mit `max_connections: 1` ist das eine Selbstblockade:
Versuch 2 kickt Versuch 1, Versuch 3 kickt Versuch 2 … Am Ende hat jeder Versuch
einen anderen gekillt und keiner streamt. Beobachtet: 48 Upstream-Versuche in
5 Minuten für denselben Sender.

## Fix (2026-10-23)

- Bei `409` **kein** IP-Rotation mehr: Schleife stoppen, einmal loggen, Host
  *nicht* als failed markieren (`recordHostUse` überspringen — der Host antwortet
  ja, er verweigert nur die Session).
- Antwort an den Client: `503` + `Retry-After: 5` (Konstante
  `SLOT_CONFLICT_RETRY_AFTER_S`), damit der Player pausiert statt im Sekundentakt
  den Slot zu stehlen. `409` ist für Player kein „später nochmal"-Signal, `503`
  mit `Retry-After` schon.
- Test: `server/routes/proxy-multi-ip.test.ts` → „does not rotate IPs on HTTP 409".

## Diagnose-Rezept (bewährt)

1. **An Gecko vorbei** testen: Upstream-URL mit `curl` direkt vom Server
   (`/live/<src-user>/<src-pass>/<id>.ts`), inkl. `-L` (die Panels antworten oft
   302 auf einen Edge-Host — der eigentliche Fehler kommt erst dort).
2. Panel-Status prüfen: `player_api.php` ohne `action` →
   `auth`, `status`, `active_cons`, `max_connections`. `active_cons` zählt nur
   die Panel-Sicht, nicht zwingend die Edge-Slots.
3. Gegentest mit einer anderen Quelle vom selben Server: läuft die, ist weder die
   Server-IP gesperrt noch der Proxy kaputt.
4. Body lesen, nicht nur den Status. `503` nach konstant ~10 s ohne Body ist ein
   Origin-Timeout der Edge; `409` mit diesem JSON ist ein Slot-Konflikt.
