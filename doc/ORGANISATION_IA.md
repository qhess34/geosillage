# Organisation IA du projet

Comment le projet est mené avec des agents IA (sessions Claude Code) : qui décide, qui fait, quel modèle, dans quel ordre.
Les règles de code sont dans [AGENTS.md](../AGENTS.md) ; ce document ne les répète pas.

## Rôles

| Rôle | Responsabilités |
|---|---|
| **Propriétaire** | Décide des priorités, autorise les fusions. |
| **Chef de projet technique** (session Claude orchestratrice) | Backlog (issues GitHub), sprints, estimation du coût en tokens, budget et quota, délégation, contrôle des PR, archivage des sessions. |
| **Consultant IA (sobriété)** | Optimise la consommation de tokens. Apports : règles « Contribuer sobrement » d'AGENTS.md (#28), `tools/check.sh` (sortie réduite), AGENTS.md allégé, sommaire de GUIDE_CODE.md (#31). |
| **Sessions de dev temporaires** | Une session neuve par tâche (ou par lot de petites corrections), archivée dès la tâche terminée. |
| **Sous-agents** (outil Agent d'une session) | Seulement si nécessaire ; préférer `grep -n` et la carte rapide d'AGENTS.md. |

## Choix du modèle (estimations)

| Taille | Exemples | Modèle | Budget estimé |
|---|---|---|---|
| S | texte, doc, petit correctif d'interface | Haiku | ~150 k tokens |
| M | correctif ou fonction standard (serveur + interface + test e2e), revue de PR peu risquée | Sonnet | ~500 k tokens |
| L | EXIF / orientation, synchro, migrations SQLite, publication Panoramax, performance | Opus | ~1,5 M tokens |

## Cycle d'une demande

| Étape | Contenu |
|---|---|
| 1. Issue | Issue GitHub avec la taille estimée (S, M, L). |
| 2. Brief | Court : l'issue, les fichiers à toucher (carte rapide d'AGENTS.md), la commande `tools/check.sh` ciblée. |
| 3. Session | Neuve, sur l'environnement cloud « GeoSillage ». |
| 4. Branche et PR | Une branche, une PR vers `main`. |
| 5. CI | Vérifications GitHub au vert. |
| 6. Revue | Relecture du diff et du statut du CI, pas des journaux complets. |
| 7. Fusion | Sur autorisation du propriétaire. |
| 8. Archivage | Session archivée une fois la tâche terminée. |

## Environnements cloud

| Environnement | Usage |
|---|---|
| **GeoSillage** | Développement. ExifTool, `.venv`, `node_modules` du frontend et de l'e2e installés par le script de démarrage (~45 s). |
| **Cartographie (tuiles de carte)** | Captures du guide : fonds de carte et Panoramax accessibles. |

## Instructions lues par les agents

| Document | Lecture |
|---|---|
| `CLAUDE.md` | Renvoie à `AGENTS.md`. |
| `AGENTS.md` | Règles, carte rapide, sobriété. |
| `doc/GUIDE_CODE.md`, `doc/DEVELOPPEMENT.md`, `doc/GUIDE_UTILISATEUR.md` | Lus par section (`grep -n '^## '`, puis `sed -n`). |
| Consignes de sobriété | Ajoutées au prompt système de chaque session de dev. |

## Mesures et décisions

| Sujet | Constat ou décision |
|---|---|
| Contexte de départ d'une session | ~82 k tokens (≈ 0,02 $ en Haiku). |
| Revue de la PR #31 en Sonnet | ≈ 0,29 $. |
| Sessions permanentes | **Non retenues.** Un agent ne peut pas exécuter `/clear` lui-même, ni sur message d'une autre session. Sans vidage, le contexte s'accumule d'une tâche à l'autre. Une session neuve par tâche coûte presque autant qu'une session vidée. |
| Petites corrections | Regroupées dans une seule PR. |
| Captures du guide | Seulement à la demande du propriétaire. Les changements d'écran sont suivis dans l'issue « Mettre à jour les captures du guide » (label `documentation`). |
| Quota hebdomadaire | Surveillé. En alerte : seulement des tâches S et M, une session à la fois, pas de tâche L. |

## Backlog suivi

Issues GitHub, avec les labels `enhancement` (fonctions) et `documentation` (docs, captures).
