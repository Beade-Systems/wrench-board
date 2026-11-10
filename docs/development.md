# Installation, Tests und Architektur

## Reproduzierbare Installation

Die Anwendung verwendet Python 3.13 und **uv 0.13.7**. `.python-version` und
`uv.lock` legen Interpreter-Serie und aufgelöste Python-Pakete fest. Die
Lockdatei gehört ins Repository. `make install` verwendet `--locked` und
ändert die Paketversionen nicht beiläufig.

```sh
python3 -m pip install uv==0.13.7
make install                    # Laufzeit + pytest/ruff
cp .env.example .env            # Nur bei einer neuen Installation
make check-web
make test-all
make serve HOST=127.0.0.1 PORT=8000
```

`uv` kann Python 3.13 installieren, falls es noch fehlt. Für einen Server ohne
Entwicklungswerkzeuge: `make install-prod`. Dieses Ziel synchronisiert die
Umgebung und entfernt zuvor installierte Test-Extras. `make serve` startet
ohne Reload und ohne Managed-Agents-Bootstrap. `make run` bleibt der bisherige
Entwicklungsstart. `UV=/pfad/zu/uv` und `VENV=/pfad/zur/venv` sind überschreibbar.

Optional beschleunigen Rust-Module das Parsen von TVW- und FZ-Boards. Ohne sie
läuft der gleichwertige Python-Code. `make install-native` benötigt `cargo` und
muss nach jedem `make install` oder `make install-prod` erneut laufen, weil
`uv sync` die Module entfernt.

Für PDF-Verarbeitung unter Debian/Ubuntu:

```sh
sudo apt-get install poppler-utils ghostscript
```

Für beliebige native `.kicad_pcb`-Uploads zusätzlich `kicad` installieren.
`KICAD_PYTHON` wählt den Interpreter mit `pcbnew`, standardmäßig
`/usr/bin/python3`. Die virtuelle Umgebung muss `pcbnew` nicht enthalten.
Ohne KiCad können bestehende, zum Datei-Hash passende `.extract.json`-Sidecars
beim Lesen vom Datenträger verwendet werden; ein nackter KiCad-Upload benötigt
weiterhin KiCad. BRD und die übrigen Boardview-Parser sind davon unabhängig.

Die Bibliothek ist unter `/library.html` erreichbar. `MEMORY_ROOT` enthält
persistente Daten; vor Updates sichern. `PCB_LIBRARY_SOURCE_ROOT` zeigt auf
die vorhandene Sammlung (Standard: `xzz_downloads` neben dem Repository).
Ein leerer Wert deaktiviert den lokalen Katalog. Dieser ist für Anfragen mit
`X-Owner-Ref` nicht verfügbar. Ein Upload in die Bibliothek kopiert ausschließlich
die gewählte Datei; der Quellkatalog bleibt unverändert.

## Automatisierte Browserprüfungen

```sh
make install-browser
# Auf einem neuen Linux-System ggf. Systembibliotheken nachinstallieren:
.venv/bin/python -m playwright install-deps chromium
make test-browser
```

Alternativ einen vorhandenen Chromium verwenden:

```sh
UV_PROJECT_ENVIRONMENT=.venv uv sync --locked --extra dev --extra browser
CHROMIUM_EXECUTABLE=/usr/bin/chromium make test-browser
```

Die Tests starten einen eigenen Uvicorn-Prozess auf einem freien lokalen Port
mit temporärer Bibliothek und Testkatalog. Sie verändern keine produktiven
Platinen und senden keine KI-Anfragen. Geprüft werden Uploads, Fehlerantworten,
Duplikate, Bibliothek bearbeiten/löschen/herunterladen, Suche, Seitenwahl,
Zoom, Farben, spätes Eintreffen alter Anfragen und Viewer-Aufräumen.
`make test` und `make test-all` schließen Browserprüfungen ausdrücklich aus;
`make test-browser` aktiviert sie. Die Workbench lädt ihre bestehenden
Three.js/CDN-Abhängigkeiten; dafür benötigt der Browser Netzwerkzugriff oder
die vorhandenen lokalen Vendor-Dateien (`make pin-cdn`).

Bei bewussten Paketupdates: `make update-lock`, anschließend `make install`,
`make test-all`, `make check-web` und `make test-browser` ausführen.

## Docker

```sh
docker build -t wrench-board .
# Für native KiCad-Uploads:
docker build --build-arg INSTALL_KICAD=1 -t wrench-board:kicad .

docker run --rm --env-file .env -p 127.0.0.1:8000:8000 \
  -v wrench-memory:/app/memory \
  wrench-board
```

Die Python-Abhängigkeiten kommen aus derselben Lockdatei. Rust-Beschleuniger
werden mit Rust 1.85.1, Maturin 1.9.6 und den vorhandenen Cargo-Lockdateien
gebaut. Der finale Container enthält keine Rust-Werkzeuge. `managed_ids.json`
ist keine Voraussetzung mehr für den Image-Build: Wer Managed Agents verwendet,
mountet seine Datei zusätzlich schreibgeschützt nach `/app/managed_ids.json`.
Eine lokale Sammlung wird ebenfalls separat schreibgeschützt gemountet und
über `PCB_LIBRARY_SOURCE_ROOT` konfiguriert. `.env` und Benutzerdaten werden
vom Build-Kontext ausgeschlossen.

## Zuständigkeiten im Code

- `api/board/imports.py`: Größenprüfung, Formatprüfung, Hash, Parsing und frühe
  Duplikaterkennung. Keine FastAPI-Abhängigkeit. Upload und Katalog führen die
  gesamte Operation in einem Worker aus.
- `api/board/library_store.py`: Besitzertrennung, Metadaten und atomare Ablage
  von Original, Board und Metadaten unter einem Dateisystem-Lock.
- `api/board/library.py`, `router.py`, `source_catalog.py`: HTTP-Endpunkte;
  gemeinsame Importfehler werden in `http_errors.py` übersetzt.
- `web/js/pcb_viewer.js`: öffentliche Viewer-Klasse, Initialisierung und
  Lebenszyklus. Methodenmodule in `web/js/pcb/` teilen Rendering, Pins,
  Komponenten, Ebenen, Auswahl, Navigation, Eingabe, Suche und Overlays auf.
  Der gemeinsam genutzte Instanzzustand und die vorhandene globale API bleiben
  für die Workbench erhalten. Es ist kein Build-Schritt erforderlich.
- `web/js/shared/render_scheduler.js`: maximal ein ausstehendes Bild pro Viewer;
  im Leerlauf wird kein neuer Frame angefordert. Beide Viewer verwenden ihn.

Der Parse-Cache ist pro Prozess auf 16 Einträge und 32 MiB serialisierte Daten
begrenzt. Zeitgleiche gleiche Uploads teilen sich die Parse-Arbeit innerhalb
eines Prozesses und Besitzers. Verschlüsselte Formate werden beim direkten
Parse-Aufruf erneut geprüft, damit geänderte Schlüssel wirken. Bibliotheks-
Duplikate werden zusätzlich dauerhaft anhand ihres Datei-Hashes erkannt und
behalten ihre gespeicherten Metadaten. Ein erneuter Import desselben Inhalts
ersetzt ein bereits gespeichertes Board nicht; zur bewussten Neuinterpretation
zuerst den Bibliothekseintrag entfernen.

`make clean` entfernt generierte Python-/Test-Caches außerhalb von `.venv`,
`venv`, dem konfigurierten `VENV` und `.git`; persistente Bibliotheksdaten bleiben
unberührt. Der SQLite-Katalog unter `memory/_pcb_catalog` lässt sich bei
**gestoppter Anwendung** entfernen und wird anschließend neu erstellt.

## Einrichtung über die Oberfläche

Unter **Bibliothek → Einstellungen** (`/settings.html`) können Nutzer:

- mehrere vorhandene Ordner verknüpfen und die aktive Sammlung wählen;
- serverseitige Ordner durchsuchen (bei Docker zuvor als Volume einbinden);
- FZ-Schlüssel ausdrücklich von GitHub laden oder manuell einfügen;
- den XZZ-Standardschlüssel überschreiben sowie KI-Schlüssel und Modelle ändern;
- einen begrenzten oder vollständigen Import-Prüflauf starten, stoppen und als JSON herunterladen.

Gespeicherte Werte liegen in `MEMORY_ROOT/_workbench_settings.json` mit Dateirechten
0600. Die Oberfläche gibt gespeicherte Schlüssel nicht zurück. Diese Datei enthält
Geheimnisse und gehört wie `.env` nicht ins Repository. UI-Werte haben Vorrang vor
`.env`; ein leeres Schlüsselfeld beim Speichern behält den bisherigen Wert, die
explizite Entfernen-Checkbox löscht ihn. Einstellungen gelten für neue Aufrufe ohne
Neustart; laufende Diagnose-Sitzungen können alte Clients behalten. Die API ist im
Cloud-Gateway-Modus und bei `X-Owner-Ref` gesperrt und verlangt einen eigenen Header
sowie denselben Origin. Sie ist für die bestehende eigenständige Workbench gedacht.

Der Prüflauf verarbeitet Dateien einzeln in separaten Prozessen mit 60 Sekunden
Zeitlimit und dem konfigurierten Upload-Größenlimit. Originale bleiben unverändert.
Status und Bericht bleiben im Arbeitsspeicher des Servers; vor einem Neustart den
Bericht herunterladen. Es läuft höchstens ein Prüflauf pro Serverprozess. Stoppen
wirkt nach der aktuellen Datei. Die Einstellungsseite zeigt die letzten 20 Ergebnisse,
der Bericht enthält alle Ergebnisse des aktuellen Laufs.

### Zusätzliche CAD-Formate

Altium `.PcbDoc`, CircuitMaker `.CMPcbDoc`, CircuitStudio `.CSPcbDoc` sowie XML-EAGLE
`.brd` verwenden die Importer des installierten KiCad über `KICAD_PYTHON`.
Allegro-Binärdateien werden anhand ihres Headers erkannt und mit dem mitgelieferten
BoardRipper-Parser verarbeitet. Dafür wird Node.js ab Version 18 benötigt; KiCad
ist für Allegro nicht erforderlich. `WRENCH_BOARD_NODE` kann einen alternativen
Node-Pfad festlegen. Das Docker-Image installiert Node automatisch. Herkunft,
AGPL-/GPL-Lizenzhinweise und Build-Anleitung stehen in
`api/board/parser/_boardripper/NOTICE.md`. Allegro 15 ist experimentell; Hinweise
auf unvollständige Daten werden im Viewer angezeigt. Geschätzte Bauteilpositionen
werden mit gestrichelter gelber Kontur gekennzeichnet. `/settings.html` zeigt die tatsächlich verfügbaren Importer.
Die Importer laufen mit Zeitlimit außerhalb des API-Prozesses. Der gemeinsame
Extraktor liefert die bereits für KiCad unterstützten Board-Daten; dies ist keine
Zusicherung, dass sämtliche herstellerspezifischen CAD-Objekte übernommen werden.

Starke Inhaltssignaturen erkennen umbenannte KiCad-, EAGLE-, XZZ-, einfache FZ- und
BRD-Dateien. Verschlüsselte FZ-Dateien ohne erkennbare Signatur benötigen weiterhin
eine passende Endung. Bekannte ASCII-Dialekte behalten ihre eigene Zuordnung.

### Offline-Bibliothek

Im geöffneten Board **Offline speichern** wählen. `/offline.html` zeigt die explizit
gespeicherten Kopien auch ohne Backend. IndexedDB speichert die Board-Daten lokal;
ein Service Worker hält nur die öffentlichen Viewer-Dateien vor, keine API-Antworten
oder Schlüssel. HTTPS oder localhost ist erforderlich. Browser-Speicherkontingente
und das Löschen von Website-Daten können Offline-Kopien entfernen. Neue Originaldateien,
PDFs und KI-Diagnosen sind nicht Teil dieses Offline-Modus. Kopien lassen sich einzeln
löschen. Bei Änderungen am Offline-Assetbestand die Cache-Version in
`web/offline-sw.js` erhöhen und die Import-Abhängigkeiten in `ASSETS` aktualisieren.

### Allegro mit eigenen Dateien prüfen

Der Browser-Integrationstest kann eine vorhandene Allegro-Datei durch den echten
Upload und Viewer schicken. Die Datei bleibt außerhalb des Repositorys:

```sh
WRENCH_BOARD_ALLEGRO_SAMPLE='/pfad/zur/platine.brd' \
CHROMIUM_EXECUTABLE=/usr/bin/chromium \
.venv/bin/pytest -q -m browser tests/browser/test_workbench.py \
  -k real_allegro_import_in_library
```

Der Test prüft den Import als `ALLEGRO`, vorhandene Bauteile und Pins,
Seitenwechsel, Einpassen und die Importer-Anzeige in den Einstellungen.
Ohne `WRENCH_BOARD_ALLEGRO_SAMPLE` wird nur dieser optionale Test übersprungen.

Große Allegro-Dateien können ein höheres Speicherlimit benötigen. Unter
**Einstellungen → Boardview-Schlüssel und Import** lässt sich das V8-Heap-Limit
von 128 bis 4096 MiB setzen (Standard 1024 MiB); alternativ `ALLEGRO_HEAP_MB`
in `.env`. Das ist kein Limit für den gesamten Prozessspeicher.
