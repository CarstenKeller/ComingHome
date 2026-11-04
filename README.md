# Coming Home – Kompass nach Hause

Webapp fürs Smartphone, die wie ein Kompass **Richtung und Luftlinien-Entfernung**
von der aktuellen Position nach Hause anzeigt:

> Zum Aabach 11, 33014 Bad Driburg

Im Hintergrund liegt ein Satellitenbild mit aktueller Position, Heimatpunkt und
einer direkten Linie (Großkreis) dazwischen.

## Funktionen

Bedienung: Links neben dem Kompassbereich liegen (von unten nach oben)
**Kalibrieren**, **Teilen** und **Einstellungen** (blendet oben GPS/Simulation
und die Adresssuche ein).

Kalibrieren zoomt und verschiebt die Karte so, dass die aktuelle Position
mittig im unteren Ring liegt und der Abstand zu Zuhause dem Abstand der Ringe
entspricht; der untere Ring wird blau. Gedreht wird die Karte – auch in der
Simulation – nur vom Kompass (ohne Kompass: Norden oben); den Heimatpunkt bringt
man durch Drehen des Handys in den oberen Ring.

Beim Start erscheint der Hinweis, das Handy flach zu halten.

Der Kompassbereich (rechts neben den Knöpfen) zeigt nur Kompass und
Entfernung. Wird der obere Ring grün, materialisiert sich darin ein
Galerie-Knopf und fliegt in einem Bogen über die Knopfspalte; er öffnet die
Galerie und verschwindet wieder, wenn die Galerie geschlossen wird.

Unter 200 m Entfernung wird nicht weiter gezoomt; stattdessen rücken die beiden
Ringe gleichmäßig zusammen (Abstand proportional zur Entfernung). Berühren sich
die Ringe (Ankunft), gibt es 10 Sekunden Feuerwerk über den ganzen Bildschirm
und das Handy vibriert. Danach laufen bis zu einer Entfernung von über 60 m nur
noch Kompass und Kartendrehung (Position eingefroren, kein Einrasten).
Verschiebt oder zoomt man die Karte von Hand, wird der Ring wieder weiß und der
Kalibrieren-Knopf rot. Im kalibrierten Zustand folgt die Karte neuen
GPS-Positionen automatisch.

Mit Kompass ist die Karte am Kompass ausgerichtet und dreht sich
mit dem Handy (Blickrichtung oben). Zeigt das Handy genau auf das Zuhause
(Heimatpunkt höchstens 12 px vom Ringmittelpunkt, ca. 1°), rastet es ein:
Heimatpunkt und oberer Ring werden grün, der Ring pulsiert und das Handy
vibriert 2 Sekunden (nur wo der Browser Vibration unterstützt, z. B.
Android/Chrome, nicht iPhone/Safari). Gelöst wird erst ab 20 px Abweichung.

Kartenkacheln rund um die aktuelle Position (1,5 × Bildschirmdiagonale, drei
Zoomstufen) werden automatisch vorgeladen und im Browser gespeichert
(höchstens 4000 Kacheln). Das verbraucht mobiles Datenvolumen.

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
  Ob das Vorabladen/Zwischenspeichern von Esri-Kacheln nach deren Bedingungen
  zulässig ist, ist nicht geprüft.
- Leaflet 1.9.4 liegt unter `vendor/leaflet` (BSD-2-Clause-Lizenz).
- leaflet-rotate 0.2.8 (Kartendrehung) liegt unter `vendor/leaflet-rotate`
  und steht unter der **GPL-3.0**. Wer die App weitergibt, muss deren
  Bedingungen beachten.
