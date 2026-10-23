# Puffer random-walkt ohne Rückführung (und TiviMate-Ladekreisel)

**Datum:** 2026-10-23 — Beobachtung während eines Spiels

## Symptom

TiviMate zeigt Ladekreiseln, während der Gecko-Pufferbalken „langsam abbaut",
Gecko aber „letzter Aussetzer: lange her" meldet.

## Messung (Produktion, 5 min, 60-s-Fenster)

Kumulativ pro Fenster: `downstream` (an den Client geschrieben) vs.
`upstream` (vom Provider angekommen), Live-Kanal isoliert:

```
fill=36%  ratio=1.0739
fill=44%  ratio=0.9703
fill=25%  ratio=1.0567
fill=58%  ratio=0.9085
```

Mittelwert **1.002** → **kein systematischer Verlust**. Der Pump liefert im
Mittel exakt das, was ankommt. Was schwankt, ist die Rate pro Fenster (±7 %),
und der Puffer integriert diese Schwankung: **Random Walk** von 17 % bis 58 %
der Reserve. Bei 17 % (≈3 s) reißt jede Provider-Pause (Tivione: 9,8–10,5 s
laut Code-Kommentar) → Starve → Ladekreiseln.

Wichtig für die Einordnung: **Gecko drosselt nicht nach Pufferstand.**
Die Freigaberate hängt nur an der Ratenschätzung. Bei 45 % Füllstand gingen
weiter 7,6–8,4 Mbps raus. „Puffer klein ⇒ weniger Daten" ist falsch; richtig
ist „Puffer klein ⇒ keine Reserve mehr für die nächste Provider-Pause".

## Ursache

Offene Regelschleife: `releaseRate = measureUpstreamRate()` (60-s-Fenster über
`rateBuckets`). Die Schätzung ist im Mittel richtig, streut aber einige Prozent,
weil Burst-Grenzen mal in, mal außerhalb des Fensters liegen. Nichts führt den
Füllstand zurück → der Puffer wandert.

## Fix (2026-10-23)

`nextPaceTrim()` in `stream-hub.ts`: alle 10 s wird der Füllstand (relativ zur
Reserve) geprüft und die Freigaberate um 0,5 % verstellt — nach unten unter 80 %,
nach oben über 110 %, begrenzt auf **[0,95, 1,05]**. Das ist eine schwache
Rückstellkraft statt eines Reglers: der Random Walk wird zur Ornstein-Uhlenbeck-
Bewegung um die Reserve, ohne den Player je mehr als 5 % unter Echtzeit zu
versorgen.

Bewusst **keine** „Conservation"-Ratenschätzung (arrived = released + Δbuffer):
Sie wäre exakt, würde aber den Initial-Burst (22–31 MB in 3–5 s) als Rate
interpretieren und den Puffer in Sekunden leerlaufen lassen.

## Nachmessen

`/proxy/stats` → `connections[].buffer` (neu: `rateBps` im Tooltip). Gute Werte:
`fillPercent` bleibt dauerhaft zwischen ~80 und ~130, `status` `healthy`,
`lastStarveAt` alt. Wiederkehrende `[StreamHub] ⚠️ Downstream starved`-Zeilen
heißen: Reserve zu klein für die Provider-Pausen (`GECKO_LIVE_BUFFER_SECONDS`
erhöhen) — nicht: Pacing zu langsam.
