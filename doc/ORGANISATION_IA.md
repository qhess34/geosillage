# Organisation IA du projet

Comment le projet est mené avec des agents IA (sessions Claude Code) : qui décide, qui fait, quel modèle, dans quel ordre.
Les règles de code sont dans [AGENTS.md](../AGENTS.md) ; ce document ne les répète pas.

## Rôles

| Rôle | Responsabilités |
|---|---|
| **Propriétaire** | Décide des priorités, autorise les fusions. |
| **Chef de projet technique** (session Claude orchestratrice) | Backlog (issues GitHub), sprints, estimation du coût, budget et quota, délégation, contrôle des PR, archivage des sessions. |
| **Consultant IA (sobriété)** | Optimise la consommation de tokens. Apports : règles « Contribuer sobrement » d'AGENTS.md (#28), `tools/check.sh` (sortie réduite), AGENTS.md allégé, sommaire de GUIDE_CODE.md (#31). |
| **Sessions de dev temporaires** | Une session neuve par tâche (ou par lot de petites corrections), archivée dès la tâche terminée. |
| **Sous-agents** (outil Agent d'une session) | Seulement si nécessaire ; préférer `grep -n` et la carte rapide d'AGENTS.md. |

## Choix du modèle

| Taille | Exemples | Modèle | Budget indicatif (coût relevé) |
|---|---|---|---|
| S | texte, doc, petit correctif d'interface | Haiku | ≤ 0,15 $ |
| M | correctif ou fonction standard (serveur + interface + test e2e), revue de PR peu risquée | Sonnet | ≤ 1 $ |
| L | EXIF / orientation, synchro, migrations SQLite, publication Panoramax, performance | Opus | ≤ 5 $ |

- Coût relevé par `get_session` (`usage.cost_usd`, cache compris).
- Le contexte de départ (~82 k tokens) est inclus dans chaque budget.
- Le coût réel de chaque PR est noté dans son corps.
- Budgets à recalibrer avec les premières mesures.

## Cycle d'une demande

| Étape | Contenu |
|---|---|
| 1. Issue | Issue GitHub avec la taille estimée (S, M, L). |
| 2. Brief | Court : l'issue, les fichiers à toucher (carte rapide d'AGENTS.md), la commande `tools/check.sh` ciblée. |
| 3. Session | Créée avec la tâche dans le prompt, sur l'environnement cloud « GeoSillage ». Pas de pré-chauffage ni de session de vérification à part. |
| 4. Branche et PR | Une branche, une PR vers `main`. |
| 5. CI | Vérifications GitHub au vert. |
| 6. Revue | S et M ordinaires : le chef de projet lit `git diff --stat`, le diff ciblé et le statut du CI. Session de revue séparée seulement pour L, ou M touchant EXIF/orientation, synchro ou publication. |
| 7. Fusion | Le propriétaire autorise la fusion sans son accord (8 nov. 2026) : le chef de projet fusionne après relecture et CI vert ; L : après revue par une session senior. |
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
| Sobriété | Une ligne dans le prompt système de la session renvoyant à AGENTS.md § Contribuer sobrement (pas de recopie). |

## Mesures et décisions

| Sujet | Constat ou décision |
|---|---|
| Contexte de départ d'une session | ~82 k tokens (≈ 0,02 $ en Haiku). |
| Revue de la PR #31 en Sonnet | ≈ 0,29 $. |
| PR #34 (doc, Haiku) | ≈ 0,07 $, contexte final ~112 k. |
| Sessions de dev | Une session neuve par tâche. Un agent ne peut pas exécuter `/clear` lui-même : sans vidage, le contexte s'accumule d'une tâche à l'autre. |
| Sessions permanentes (chef de projet, consultant) | Au-delà d'un sprint, ou quand le contexte devient lourd : résumé de reprise (~15 lignes : backlog, décisions, PR ouvertes), puis session neuve. |
| Suivi d'une session enfant | `get_session` (`post_turn_summary`) ; `list_events` seulement avec `kinds=["result"]`. |
| Petites corrections | Regroupées dans une seule PR. |
| Captures du guide | Seulement à la demande du propriétaire. Les changements d'écran sont suivis dans l'issue « Mettre à jour les captures du guide » (label `documentation`). |
| Quota hebdomadaire | Surveillé. En alerte : seulement des tâches S et M, une session à la fois, pas de tâche L. |

## Backlog suivi

Issues GitHub, avec les labels `enhancement` (fonctions) et `documentation` (docs, captures).
