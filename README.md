# Coming Home – Kompass nach Hause

Webapp fürs Smartphone, die wie ein Kompass **Richtung und Luftlinien-Entfernung**
von der aktuellen Position nach Hause anzeigt:

> Zum Aabach 11, 33014 Bad Driburg

Im Hintergrund liegt ein Satellitenbild mit aktueller Position, Heimatpunkt und
einer direkten Linie (Großkreis) dazwischen.

## Funktionen

- **GPS-Modus**: Position über die Ortungsfunktion des Geräts (inkl. Genauigkeitskreis).
- **Simulationsmodus**: Adresse eingeben (Geocodierung über OpenStreetMap/Nominatim)
  oder direkt auf die Karte tippen – diese Position wird statt GPS verwendet.
- **Position teilen**: Der Teilen-Knopf verschickt (z. B. per WhatsApp) die
  aktuelle Position mit Uhrzeit, Entfernung und einem Link. Wer den Link öffnet,
  sieht die Position direkt im Simulationsmodus. Alternativ die ganze Nachricht
  oder nur die Koordinaten („51.71890, 8.75750“) ins Suchfeld der Simulation
  einfügen. Die Position wird nicht live aktualisiert – sie ist ein Schnappschuss.
- **Kompass**: Der Pfeil zeigt nach Hause, die Rose dreht sich mit dem Gerät
  (Magnetometer über die DeviceOrientation-API). Ohne Kompassdaten gilt der Pfeil
  „Norden oben“, passend zur Karte.
- Installierbar als App auf dem Homescreen (Web-App-Manifest, Service Worker).

## Nutzung / Hosting

Es gibt keinen Build-Schritt – die Dateien sind direkt auslieferbar.
**Wichtig:** GPS und Kompass funktionieren im Browser nur über **HTTPS**
(oder `localhost`).

### GitHub Pages

Der Workflow `.github/workflows/pages.yml` veröffentlicht die App bei jedem Push
auf den Standard-Branch. Einmalig nötig: Repository → **Settings → Pages →
Build and deployment → Source: „GitHub Actions“**. Danach erreichbar unter

https://carstenkeller.github.io/ComingHome/

Lokal testen:

```bash
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

Auf dem iPhone muss der Kompass einmalig über den Knopf **„Kompass aktivieren“**
freigegeben werden (Vorgabe von iOS).

## Hinweise und Grenzen

- **Heimatkoordinaten**: Die Adresse wird beim ersten Start über Nominatim
  geocodiert und im Browser gespeichert. Schlägt das fehl, wird ersatzweise das
  ungefähre Zentrum von Bad Driburg verwendet (in der App deutlich markiert).
  Wer auf die Online-Abfrage verzichten will, trägt geprüfte Koordinaten in
  `app.js` unter `HOME.fixed` ein.
- **Richtung**: Angezeigt wird der Anfangskurs der kürzesten Verbindung
  (Großkreis) bezogen auf **geographisch Nord**. iOS liefert einen magnetischen
  Kompasskurs; die Missweisung liegt in Deutschland derzeit bei wenigen Grad
  (nicht korrigiert).
- **Kompassgenauigkeit** hängt vom Gerät ab; Magnetfelder (Hüllen, Autos)
  stören. Ggf. Gerät in einer Acht bewegen, um zu kalibrieren.
- **Dienste Dritter**: Satellitenbilder von Esri (World Imagery), Geocodierung
  über Nominatim (OpenStreetMap). Es gelten deren Nutzungsbedingungen
  (Nominatim: max. 1 Anfrage/Sekunde, keine Massenabfragen). Für privaten
  Gebrauch sollte das passen – eine rechtliche Prüfung ist das nicht.
- Leaflet 1.9.4 liegt unter `vendor/leaflet` (BSD-2-Clause-Lizenz).
