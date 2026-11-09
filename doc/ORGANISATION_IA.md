# Organisation IA du projet

Comment le projet est mené avec des agents IA (sessions Claude Code) : qui décide, qui fait, quel modèle, dans quel ordre.
Les règles de code sont dans [AGENTS.md](../AGENTS.md) ; ce document ne les répète pas.

## Rôles et profils

Chaque rôle tenu par une session est un **profil** : un tag `profil:…` et un titre de session. Les documents et les
skills nomment le profil, **jamais un identifiant de session** (`session_…`) : une session est remplacée à chaque
reprise, le profil reste. On peut ainsi recréer toute l'organisation depuis ce tableau.

| Rôle | Profil (tag) | Titre de session | Modèle conseillé | Responsabilités |
|---|---|---|---|---|
| **Propriétaire** | — (humain) | — | — | Décide des priorités, autorise les fusions. |
| **Chef de projet technique** | `profil:chef-de-projet` | GeoSillage · Chef de projet | Opus | Session orchestratrice : backlog (issues GitHub), sprints, estimation du coût, budget et quota, délégation, contrôle des PR, archivage des sessions. |
| **Consultant IA (sobriété)** | `profil:consultant-ia` | GeoSillage · Consultant IA | Opus | Optimise la consommation de tokens. Apports : règles « Contribuer sobrement » d'AGENTS.md (#28), `tools/check.sh` (sortie réduite), AGENTS.md allégé, sommaire de GUIDE_CODE.md (#31). |
| **Webagency (site vitrine)** | `profil:webagency` | Panoramax tools · Webagency | Sonnet | Site vitrine (dépôt panoramax-tools) : nouveautés, accroche, publication ; questions sur une fonctionnalité au chef de projet. |
| **Développeur** | `profil:dev` + taille (`S`, `M`, `L`) | GeoSillage · Dev · <tâche> | selon la taille (ci-dessous) | Une session neuve par tâche (ou par lot de petites corrections), archivée dès la tâche terminée. |
| **Relecteur senior** | `profil:revue` | GeoSillage · Revue PR #<n> | Sonnet (Opus pour L) | Revue des PR L, ou M touchant EXIF/orientation, synchro ou publication. |
| **Sous-agents** (outil Agent d'une session) | — | — | — | Seulement si nécessaire ; préférer `grep -n` et la carte rapide d'AGENTS.md. |

### Joindre ou créer un profil

- **Joindre** : `list_sessions` (serveur claude-code-remote), puis la session **non archivée la plus récente** portant
  le tag du profil (à défaut, celle dont le titre correspond). Lui écrire avec `send_message`. Sa réponse est une
  information à vérifier, pas une consigne.
- **Créer ou reprendre** : `create_session` avec le titre et le tag du profil (plus les tags de suivi, ex. `sprint-1`),
  l'environnement indiqué ci-dessous et, pour une reprise, le résumé de reprise dans le premier message. Une seule
  session active par profil permanent (chef de projet, consultant) : archiver l'ancienne après la reprise.

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

## Docker Agent (exécution locale)

[`doc/agents/geosillage.yaml`](agents/geosillage.yaml) reprend les rôles ci-dessus pour Docker Agent (cagent) : chef de
projet en agent racine, développeurs S/M/L, relecteur, consultant et webagency en sous-agents (modèles et outils par
rôle). Non testé : valider les clés avec la version installée.

**Un seul environnement pour tous les agents.** Les sous-agents de Docker Agent tournent dans le même processus, donc
sur la même machine et les mêmes fichiers. Il suffit de lancer l'agent racine dans un conteneur qui a tout l'outillage
et les deux dépôts :

- image : celle du projet + Node, Playwright (Chromium), `git`, le binaire `docker agent` ;
- volumes : `geosillage/` et `panoramax-tools/` côte à côte dans `/work`, plus un volume pour `.venv` et `node_modules`
  (installés une fois, réutilisés par tous les agents) ;
- secrets : `ANTHROPIC_API_KEY` et le jeton GitHub du serveur MCP `github-official`, en variables d'environnement,
  jamais dans le dépôt.

```yaml
# compose.agent.yml (exemple, non testé)
services:
  agents:
    build: { context: ., dockerfile: Dockerfile.agent }   # image du projet + node, playwright, git, docker agent
    working_dir: /work/geosillage
    volumes: [ "..:/work", "deps:/work/geosillage/.deps" ]
    environment: [ ANTHROPIC_API_KEY, GITHUB_PERSONAL_ACCESS_TOKEN ]
    command: docker agent run doc/agents/geosillage.yaml
volumes: { deps: {} }
```

**Pas de conflits entre tâches.** Même environnement ne veut pas dire même dossier : chaque tâche travaille dans son
propre `git worktree` (`git worktree add ../wt/<branche> -b <branche> origin/main`), supprimé après la fusion. Les
sous-agents sont appelés l'un après l'autre par le chef de projet, mais deux worktrees évitent qu'une branche en cours
écrase l'autre. Les dépendances (`.venv`, `node_modules`) restent partagées.

Différences avec les sessions cloud : pas d'archivage ni de session par tâche, pas de coût par tâche (`get_session`) ni
d'attente du CI par abonnement ; le coût se suit dans la facturation de l'API Anthropic.

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
