# Puffer-Anzeige im Dashboard (Jitter-Buffer-Health)

**Datum:** 2026-10-23

## Ausgangslage

Das Dashboard zeigte im "Now Playing" nur Bitrate und Volumen. Ob ein Client gerade
hungert, war nur im Log sichtbar (`Downstream starved for N ms`). Gleichzeitig wurden
Streamnamen abgeschnitten (`PRIME: WDR…`, `via Tivione-Ma…`), weil Name, Badges und
Aktionsbuttons in einer Zeile um Platz konkurrierten.

## Umsetzung

- `streamHub.getBufferHealth(channelKey)` → `ChannelBufferHealth`; die Schwellen stecken in
  der reinen Funktion `computeBufferHealth()` (getestet in `stream-hub.test.ts`).
- `/proxy/stats` hängt pro Verbindung `buffer` an (`null` bei VOD/1:1, Platzhaltern,
  deaktiviertem Pacing und Kanälen ohne Subscriber).
- `BufferGauge` im Dashboard: Balken + Sekundenwert + Statuswort, Tooltip mit letztem Aussetzer.
- Kartenlayout: Name volle Breite und umbrechend, IP in die Kopfzeile, Buttons in eine eigene
  Zeile unter dem Balken.

## Fallstricke (wichtig für spätere Änderungen)

1. **Bezugsgröße ist die Reserve, nicht das Memory-Cap.** `fillPercent = 100` heißt "genau die
   `GECKO_LIVE_BUFFER_SECONDS`". Gegen das Cap zu messen würde bei 18 s von z. B. 60 s max
   immer ~30 % anzeigen und den Balken nutzlos machen.
2. **`warming` ≠ `starved`.** In den ersten Sekunden nach dem Connect ist der Buffer leer und
   `measureUpstreamRate()` liefert 0 (Warmup-Fenster) — das ist kein Aussetzer. `starved` wird
   deshalb erst gemeldet, wenn eine Rate messbar ist.
3. **Kein Buffer ohne Subscriber.** Der Pump verwirft den Buffer bewusst, wenn niemand zusieht
   (z. B. reine DVR-Aufnahme). Eine 0-%-Anzeige wäre dort eine Lüge → `null`, UI zeigt keinen Balken.
4. `fillPercent` darf über 100 liegen (Burst-Überschuss). Die Zahl bleibt ehrlich, nur die
   Balkenbreite wird in der UI auf 100 geklemmt.
5. Der Wert aktualisiert sich im 2-s-Polling-Takt von `/proxy/stats` — keine zusätzliche
   Telemetrie, keine neue Tabelle.
