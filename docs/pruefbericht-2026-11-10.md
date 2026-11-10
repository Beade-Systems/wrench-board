# Skript- und Funktionsprüfung vom 10. November 2026

Die ausgeführten lokalen Prüfungen haben keine verbleibenden Testfehler ergeben.
Das ist keine Zusicherung, dass alle Cloud-Abläufe oder beliebige fremde
Board-Dateien funktionieren. Bereits vorhandene Arbeitskopie-Änderungen wurden
beibehalten und mitgeprüft.

## Ergebnisse

| Prüfung | Ergebnis |
| --- | --- |
| Gesamte Python-Suite einschließlich langsamer Tests, ohne Browser | 2.721 bestanden, 46 übersprungen, 11 Browsertests abgewählt; 235 Sekunden |
| Anschließender gezielter Lauf: `tests/scripts/ tests/test_ab_cost_diag.py` | 107 bestanden, einschließlich 33 neuer Regressionstestfälle; enthält Überschneidungen mit dem Gesamtlauf |
| `CHROMIUM_EXECUTABLE=/usr/bin/chromium make test-browser` | 10 bestanden, 1 optionaler Allegro-Test übersprungen |
| `make lint` | Erfolgreich; prüft jetzt auch `scripts/` |
| `make check-web` | 76 JavaScript-Dateien: relative Importe und Exporte geprüft; Node-Syntaxprüfung erfolgreich |
| Python-Syntaxprüfung | Alle 231 API-, 45 Skript- und 298 Testdateien erfolgreich geparst |
| CLI-/Importprüfung der 45 Python-Skripte | 30 argparse-Einstiegspunkte mit `--help` erfolgreich; übrige 15 Skripte erfolgreich importiert |
| Shell-Syntax | Alle vier `scripts/*.sh` bestehen `bash -n` |
| Rust | Beide Crates bestehen `cargo test --offline --locked`; sie enthalten jeweils **0 Rust-Unit-Tests** |
| `scan_board_corpus.py board_assets` | Beide mitgelieferten Dateien erfolgreich: BRD und KiCad, keine Parsefehler |
| JSON-Antworten der zwei geänderten Smoke-Skripte | Anführungszeichen und Backslashes in Bauteilnamen korrekt serialisiert |

Der Gesamtlauf begann vor den Korrekturen. Die geänderte Skriptlogik und alle
neuen Regressionstests wurden anschließend gezielt erneut ausgeführt. Die
Testzahlen dürfen deshalb nicht einfach addiert werden.

CLI-/Importprüfungen liefen in separaten Prozessen mit blockierten
Netzwerkverbindungen, Unterprozessen und Dateimutationen. `--help` und Import
prüfen Startfähigkeit und Abhängigkeiten, nicht den vollständigen Betriebsablauf.
Die Python-Suite verwendete einen temporären `MEMORY_ROOT` und leere Cloud- und
KI-Zugangskonfigurationen; die Browsertests starten ihren eigenen isolierten Server.

## Behobene Fehler

- `analyze_mount_usage.py`: JSON-Listen wurden vor der Typprüfung wie Objekte
  angesprochen und verursachten einen Absturz. Unterstützte Eingabeformen werden
  jetzt getrennt behandelt; ungültige Dateien erhalten eine CLI-Fehlermeldung.
- Mount-Auswertung: Suchverzeichnisse haben Vorrang vor Suchmustern; Mountnamen
  werden an Pfadbestandteilen erkannt. Serverseitige Speicheraufrufe erscheinen
  jetzt in der Tabelle. Fehlende Szenario-IDs verursachen keinen Absturz mehr.
- `eval_all.py`: Nicht endliche Scores und boolesche Werte werden zurückgewiesen.
  Das verhindert erfolgreiche Auswertungen mit `NaN` oder unendlichen Werten.
  Byte-Ausgaben nach Prozess-Timeouts werden vor der JSON-Serialisierung dekodiert.
- `purge_oversized_seeds.py`: Lokale Marker werden nur für bereits abwesende oder
  erfolgreich gelöschte Cloud-Einträge entfernt. Fehlgeschlagene Löschungen bleiben
  nachvollziehbar; Netzwerk-/Löschfehler führen zu einem Fehlerstatus.
- Zwei Smoke-Skripte erzeugen ihre Komponenten-Antworten mit `json.dumps`, sodass
  Sonderzeichen nicht mehr zu ungültigem JSON führen.
- 25 vorhandene Ruff-Befunde in Skripten bereinigt und `scripts/` dauerhaft in
  `make lint` aufgenommen.

## Prüfgrenzen und Voraussetzungen

- Die 46 übersprungenen Python-Tests wurden nicht ausgeführt. Grüne Ergebnisse
  gelten nur für tatsächlich ausgeführte Tests.
- Der echte Allegro-Browserimport benötigt eine eigene Datei über
  `WRENCH_BOARD_ALLEGRO_SAMPLE`; diese optionale Prüfung wurde übersprungen.
- Kostenpflichtige KI-/Managed-Agents-Abläufe, Provisionierung, Cloud-Löschungen,
  echte Datenmigrationen und der Evolve-Dauerbetrieb wurden nicht live gestartet.
  Entsprechende Unit-Tests ersetzen keine Prüfung mit einem echten Cloud-Konto.
- `evolve-runner.sh` benötigt die hier fehlende Datei
  `.claude/skills/microsolder-evolve/SKILL.md` sowie das ebenfalls nicht im `PATH`
  verfügbare `claude`-CLI und ist damit derzeit nicht startfähig.
- Docker-Build und Deployment wurden nicht ausgeführt. Rust-Kompilierung allein
  beweist nicht die Funktion sämtlicher nativer Python-Bindings.
- Pytest meldet eine bestehende Starlette/httpx-Abkündigungswarnung; die Tests
  funktionieren mit der installierten Abhängigkeitskombination.
