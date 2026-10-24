# Reserve ist ein Floor — Überschuss gehört in den Player-Puffer

**Datum:** 2026-10-24

## Entscheidung

Der Jitter-Buffer in Gecko hält **nur die Reserve** (Default jetzt 12 s, vorher 18).
Alles darüber geht sofort an die Clients, statt mit 1,08× über Minuten abgebaut zu
werden. Der Client-Puffer ist pro Sekunde robuster als der Server-Puffer:

| Ausfall | Gecko-Puffer | Player-Puffer |
|---|---|---|
| Provider-Pause 10 s | ✅ wandelt Stille in gleichmäßigen Strom | ✅ leert sich derweil |
| Failover/Reconnect 15 s | ✅ | ✅ |
| WLAN-Hänger zwischen Gecko und Client | ❌ | ✅ |
| Decoder-Stall/GC im Player | ❌ | ✅ |

Nur eine Aufgabe kann der Gecko-Puffer allein: Provider-Stille in einen
gleichmäßigen Ausgabestrom wandeln (sonst sieht der Player 8–10 s gar nichts und
läuft in seinen Read-Timeout). Dafür muss die Reserve **größer als die längste
Provider-Pause** sein — nicht größer. Deshalb 12 s statt 18 s.

## Warum das die Ladekreisel behebt

Vorher: `releaseRate = 1,0×`, und oberhalb von 1,2× Reserve nur 1,08×. Bei 8 Mbps
sind 8 % ≈ 0,64 Mbit/s, also 8 s Überschuss in ~100 s. In der Praxis wurde die
1,2×-Schwelle nie erreicht → der Player bekam **nie** einen Puffer. Sein Puffer
stand bei null, und jeder 300-ms-Hänger (WLAN, GC auf der Shield, Decoder)
führte sofort zum Spinner — während Geckos eigener Puffer voll und „healthy" war.
Beobachtet: Gecko 35–90 % Füllstand, kein Starve, Downstream konstant 7,4–8,4
Mbps, trotzdem Ladekreisel.

## Umsetzung

- `LIVE_BUFFER_DEFAULT_RESERVE_S` 18 → **12**.
- `pumpChannelBuffer`: `surplus = pacing && bufferedBytes > reserveBytes && hasClientHeadroom()`.
  Bei `surplus` wird **ohne Token-Verbrauch** freigegeben, bis nur noch die Reserve
  übrig ist.
- `hasClientHeadroom()`: stoppt den Hand-off, wenn ein Subscriber mehr als
  `LIVE_CLIENT_HEADROOM_MAX_BYTES` (4 MB) in `res.writableLength` hat — bewusst
  weit unter `BUFFER_WARN_BYTES` (16 MB), damit der Hand-off nie als Stall zählt.
- Der Trim (`nextPaceTrim`) gilt weiter nur für die Reserve.

## Fallstricke

- **Beim Verbindungsaufbau ist die Ratenschätzung kurzzeitig zu hoch** (der
  Connect-Burst von ~22 MB landet im 60-s-Fenster, gedeckelt auf 2,5 MB/s). Dann
  ist `reserveBytes` ebenfalls groß und die Surplus-Regel greift erst, wenn sich
  die Schätzung beruhigt (ca. 30–60 s). In der Praxis unkritisch, weil der zu hoch
  getaktete Ausgang den Rückstau in derselben Zeit ohnehin zum Client schiebt.
- Ein **zu großer** Client-Puffer ist der Preis: die Latenz wächst auf
  Reserve + Player-Puffer (beobachtet ~40 s). Bewusste Entscheidung — Smoothness
  vor Latenz.
- `GECKO_LIVE_BUFFER_SECONDS=0` schaltet alles ab (reines Passthrough). Dann
  landet auch der Connect-Burst komplett im Player und lässt sich nicht mehr
  zurückholen — für Latenz ist das *schlechter* als ein kleiner Floor, nicht besser.
