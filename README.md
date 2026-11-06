<p align="center">
  <img src="frontend/public/logo.svg" alt="GeoSillage" width="120" />
</p>

# GeoSillage

**Préparez et corrigez vos relevés photo 360° pour [Panoramax](https://panoramax.fr).**

Application locale de préparation, correction et publication de séquences [Panoramax](https://panoramax.fr)
à partir de photos 360° GoPro MAX (vélo, à pied, en voiture… ; une photo toutes les ~2 s, des milliers de photos par sortie).

Par défaut les fichiers originaux ne sont **pas modifiés** : les projets ne stockent que des références vers les
photos, les métadonnées lues et les corrections, et l'export produit des copies. Sur demande explicite (avec
confirmation), l'export peut aussi modifier les EXIF des photos sources, sur place ou en les déplaçant dans un dossier
par séquence ; les valeurs d'origine sont alors sauvegardées et « Restaurer les photos sources » les remet.

## État d'avancement

| Phase | Contenu | État |
|---|---|---|
| 1 | Étude GoPro MAX / API Panoramax, architecture ([doc/ETUDE_PHASE1.md](doc/ETUDE_PHASE1.md)) | ✅ |
| 2a | Projets, import récursif, lecture EXIF par lots, bilan d'import, anomalies, miniatures en tâche de fond, carte | ✅ |
| 2c | Séquences (plage, découpage proposé, couper, fusionner, limites), timeline, annuler/rétablir, raccourcis | ✅ |
| 2d (partiel) | Cap : calcul automatique, manuel, par plage, décalage sur toute la sortie ou une série de photos ; **export d'un dossier par séquence avec EXIF corrigés** | ✅ |
| 2b | Visionneuse 360° (Photo Sphere Viewer), sens de déplacement pour caméra sur casque | ✅ |
| 2b (reste) | Liste des photos (virtualisée, filtres d'anomalies) | backlog |
| 2d | Correction GPS : glisser sur la carte, saisie, placer une photo sans GPS, décalage et déplacement le long du trajet sur une plage ; export en copie, en déplaçant les sources, ou sur place ; restauration des sources | ✅ |
| 2d (reste) | Exports GeoJSON/CSV des positions | backlog |
| 2e | Photos sans position : liste par trou, voisines sur la carte, interpolation, rattachement à la séquence | ✅ |
| 3 (complément) | Synchro par tronçons (« à partir de cette photo ») ; vérifications automatiques GitHub | ✅ |
| 3 (partiel) | **Retard GPS** : synchronisation en faisant glisser une photo le long de la trace sur la vue satellite, points de calage, application à la sortie / séquence / plage ; visionneuse zoomable | ✅ |
| 3 | Recalage sur les voies OSM d'une sélection (tronçons, choix de la voie si ambiguïté, aperçu) | ✅ |
| 3 (reste) | Import GPX | à faire |
| 4 | Publication Panoramax par séquence (bouton « Publier » de chaque séquence exportée, onglet Export et envoi, connexion par lien de validation, attributs : mode de déplacement et attributs libres, reprise d'un envoi interrompu) | ✅ |
| 4 (suite) | Projet Panoramax : corriger des séquences déjà publiées (choisies dans son compte), envoi des seules différences, retour en arrière | ✅ |
| Qualité | Points à vérifier avant publication (arrêts, grands écarts, précision GPS, caps) : Bilan et timeline | ✅ |
| Interface | Barre d'étapes (import, synchro, doublons et arrêts, correction GPS, séquences, export, envoi) : état et accès direct | ✅ |
| Interface | Comparer les photos d'un arrêt, N / Maj+N, pastille de sélection, légende, survol de la timeline, reprise de l'état, confirmations dans la page, notifications de fin de tâche, boutons regroupés | ✅ |
| Qualité | Tests d'interface (Playwright) dans les vérifications automatiques GitHub | backlog |

## Documentation

| Pour | Document |
|---|---|
| **Utiliser l'outil** (écran par écran, raccourcis, questions fréquentes) | [doc/GUIDE_UTILISATEUR.md](doc/GUIDE_UTILISATEUR.md) |
| Développer (installation, vérifications, recettes, conventions) | [doc/DEVELOPPEMENT.md](doc/DEVELOPPEMENT.md) |
| Agents IA : règles du dépôt | [AGENTS.md](AGENTS.md) |
| Fonctionnement interne (modules, données, algorithmes, pièges) | [doc/GUIDE_CODE.md](doc/GUIDE_CODE.md) |
| Étude GoPro MAX / API Panoramax | [doc/ETUDE_PHASE1.md](doc/ETUDE_PHASE1.md) |

## Préparer une sortie en bref

1. **Importer** les dossiers de la sortie ; le bilan (anomalies GPS, doublons, interruptions) est dans *Bilan*.
2. **Découper** en séquences en parcourant les photos (← →) : `D` début, `F` fin (la suivante commence aussitôt),
   `C` couper, `X` exclure ; ou découpage proposé automatiquement.
3. **Corriger le retard GPS** (*Synchro*) : glisser une photo le long de la trace sur la vue satellite.
4. **Corriger les positions** (`M`) : glisser le point ; `→` reporte la même correction sur les suivantes.
5. **Vérifier caps et orientation** : sens de déplacement pour une caméra sur casque, correction du montage.
6. **Exporter** un dossier par séquence (`<projet>_1`, `_2`…) avec EXIF corrigés ; réexporter ce qui a changé.
7. Publier chaque dossier sur Panoramax comme une seule séquence.

Tout est annulable (`Ctrl+Z`) ; `?` affiche les raccourcis. Détails : [guide d'utilisation](doc/GUIDE_UTILISATEUR.md).

## Lancement avec Docker (recommandé)

```sh
cp .env.example .env        # puis indiquer PHOTOS_DIR (vos sorties GoPro), et PUID/PGID (commande : id -u ; id -g)
mkdir -p data photos exports  # (ou les dossiers indiqués dans .env) : à créer AVANT le premier lancement
docker compose up -d --build
```

Puis ouvrir http://127.0.0.1:8765 (publié sur cette machine uniquement : l'API donne accès aux dossiers montés).

Dans l'application, les dossiers montés apparaissent ainsi :

| Dans l'application | Sur votre machine (`.env`) | Rôle |
|---|---|---|
| `/photos` | `PHOTOS_DIR` | photos à importer ; modes d'export *Déplacer* / *Sur place* (ex. `/photos/sequences`) |
| `/exports` | `EXPORTS_DIR` | exports en mode *Copier* |
| `/data` | `DATA_DIR` | projets (bases SQLite, miniatures) |

- Le conteneur tourne avec l'utilisateur `PUID:PGID` : les exports et les photos modifiées ou déplacées gardent ce
  propriétaire. Si les dossiers n'existent pas, Docker les crée en root et l'application s'arrête avec un message
  explicite (`docker compose logs`).
- Les chemins enregistrés dans un projet sont ceux vus par le conteneur (`/photos/…`) : un projet créé avec Docker
  s'utilise avec Docker (et inversement pour `run.sh`).
- Mise à jour : `git pull && docker compose up -d --build`. Arrêt : `docker compose down` (les projets restent dans
  `DATA_DIR`).

## Installation sans Docker (Linux)

Prérequis : Python ≥ 3.11, Node.js ≥ 20, ExifTool.

```sh
sudo apt install libimage-exiftool-perl
./run.sh          # 1re fois : crée .venv, construit l'interface ; puis http://127.0.0.1:8765
```

Les projets sont stockés dans `~/.local/share/panoramax-studio/projects/<id>/` (`project.sqlite` + `thumbs/`),
ou dans `$PSS_DATA_DIR/projects`.

## Développement

```sh
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements-dev.txt
cd backend && ../.venv/bin/uvicorn app.main:app --reload --port 8765   # API
cd frontend && npm ci && npm run dev                                     # interface (proxy /api → 8765)
cd backend && ../.venv/bin/python -m pytest -q                           # tests
```

Vérifications avant commit, tests de bout en bout et recettes : [doc/DEVELOPPEMENT.md](doc/DEVELOPPEMENT.md).
Agents IA : [AGENTS.md](AGENTS.md).
