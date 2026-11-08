"""Server messages in French (the key and the fallback) and English.

The language comes from the `Accept-Language` header (set by the interface on every call). Messages are
translated when they are *read* (error response, job list, undo labels), so stored texts stay French and
the language can change at any time. Text coming from Panoramax, ExifTool or the photos is never translated.
"""

import contextvars
import re

_lang: contextvars.ContextVar[str] = contextvars.ContextVar("lang", default="fr")

# French text -> English; `{name}` marks a variable part (any text, translated too when it is a known message)
EN: dict[str, str] = {
    # main.py
    "Nom vide": "Empty name",
    "Réglage invalide : {x}": "Invalid setting: {x}",
    "Chemin introuvable : {p}": "Path not found: {p}",
    "Photo introuvable": "Photo not found",
    "Miniature pas encore générée": "Thumbnail not generated yet",
    "Fichier source introuvable": "Source file not found",
    "Dossier introuvable": "Folder not found",
    "Accès refusé au dossier {p} (droits de lecture)": "Access denied to folder {p} (read permission)",
    "Dossier illisible : {p} ({e})": "Unreadable folder: {p} ({e})",
    "durée d'une interruption (s)": "interruption duration (s)",
    "vitesse d'un saut GPS (m/s)": "GPS jump speed (m/s)",
    "distance d'un saut GPS (m)": "GPS jump distance (m)",
    "distance minimale du cap (m)": "minimum heading distance (m)",
    "fenêtre de temps du cap (s)": "heading time window (s)",
    "distance d'un arrêt (m)": "stop distance (m)",
    "nombre de photos d'un arrêt": "photos in a stop",
    "grand écart (m)": "large gap (m)",
    "précision GPS (DOP)": "GPS accuracy (DOP)",
    "écart de cap (°)": "heading difference (°)",
    "{n} : au moins {v}": "{n}: at least {v}",
    "{n} : plus de {v}": "{n}: more than {v}",
    "{n} : au plus {v}": "{n}: at most {v}",
    "{n} : moins de {v}": "{n}: less than {v}",
    "{n} : réglage inconnu": "{n}: unknown setting",
    "{n} : nombre attendu": "{n}: number expected",
    "Projet introuvable": "Project not found",
    "Base du projet occupée par une tâche en cours : rien n'a été modifié, réessayez dans un instant.":
        "Project database busy with a running task: nothing was changed, try again in a moment.",
    # routes_edit.py
    "Impossible dans un projet Panoramax (séquences déjà publiées) : seules les corrections sont envoyées":
        "Not possible in a Panoramax project (already published sequences): only corrections are sent",
    "Indiquez des photos ou une plage": "Give photos or a range",
    "Rien à annuler": "Nothing to undo",
    "Rien à rétablir": "Nothing to redo",
    "Indiquez des photos, une séquence, une plage ou toutes les photos": "Give photos, a sequence, a range or all photos",
    "Aucune photo": "No photo",
    "Indiquez la plage de photos ou toute la sortie": "Give the photo range or the whole ride",
    "Latitude et longitude vont ensemble": "Latitude and longitude go together",
    "Aucune photo positionnée dans la sélection": "No positioned photo in the selection",
    "Aucune trace GPX importée": "No GPX track imported",
    "Fichier introuvable": "File not found",
    "Fichier GPX trop gros (50 Mo au plus)": "GPX file too large (50 MB at most)",
    "Photo introuvable ou sans date": "Photo not found or without date",
    "Séquence manquante": "Missing sequence",
    "Photo de départ manquante": "Missing start photo",
    "Plage manquante": "Missing range",
    "Dossier de destination manquant": "Missing destination folder",
    "Le chemin d'export n'est pas un dossier": "The export path is not a folder",
    "Le dossier d'export ne doit pas être dans un dossier source ({src})": "The export folder must not be inside a source folder ({src})",
    "Aucune séquence à exporter": "No sequence to export",
    "Une autre tâche sur les fichiers est en cours": "Another file task is running",
    "Séquence introuvable": "Sequence not found",
    "Cette séquence n'a jamais été exportée : utilisez l'onglet Export": "This sequence has never been exported: use the Export tab",
    "Aucune photo exclue à déplacer": "No excluded photo to move",
    "Aucune photo source modifiée": "No modified source photo",
    # routes_publish.py / panoramax.py
    "Séquences déjà publiées : utilisez « Envoyer les corrections »": "Sequences already published: use \"Send corrections\"",
    "Une autre tâche (export, import, publication) est en cours": "Another task (export, import, publication) is running",
    "Adresse d'instance invalide (https://…)": "Invalid instance address (https://…)",
    "Attribut incomplet : il faut une clé et une valeur (clé=valeur)": "Incomplete attribute: a key and a value are needed (key=value)",
    "Attribut trop long : {k}": "Attribute too long: {k}",
    "Trop d'attributs (100 au plus)": "Too many attributes (100 at most)",
    "{what} : erreur {code} de l'instance ({msg})": "{what}: error {code} from the instance ({msg})",
    "Instance injoignable ({inst}) : {e}": "Instance unreachable ({inst}): {e}",
    "Réponse inattendue de l'instance (jeton ou lien de validation manquant)": "Unexpected response from the instance (token or validation link missing)",
    "Pas de connexion en cours : « Se connecter » d'abord": "No connection in progress: use \"Sign in\" first",
    "Non connecté à Panoramax : onglet Envoi, « Se connecter »": "Not signed in to Panoramax: Send tab, \"Sign in\"",
    "Séquence {sid} introuvable": "Sequence {sid} not found",
    "« {name} » n'a jamais été exportée : exportez-la d'abord (onglet Export)": "\"{name}\" has never been exported: export it first (Export tab)",
    "Le réexport de « {name} » a signalé des problèmes : publication annulée": "Re-exporting \"{name}\" reported problems: publication cancelled",
    "« {name} » : aucune photo exportée": "\"{name}\": no exported photo",
    "« {name} » : {n} fichier(s) exporté(s) introuvable(s), réexportez la séquence": "\"{name}\": {n} exported file(s) not found, export the sequence again",
    "{n} fichier(s) non envoyé(s) ; relancez la publication": "{n} file(s) not sent; start the publication again",
    "« {name} » : {n} fichier(s) non envoyé(s) (relancez : l'envoi reprendra) — {e}": "\"{name}\": {n} file(s) not sent (start again: sending will resume) — {e}",
    "« {name} » : {msg}": "\"{name}\": {msg}",
    "L'instance a créé {n} séquences au lieu d'une": "The instance created {n} sequences instead of one",
    "{a} photo(s) publiée(s) sur {b}": "{a} of {b} photo(s) published",
    "Séquence introuvable sur l'instance (identifiant, ou séquence d'un autre compte ?)": "Sequence not found on the instance (identifier, or another account's sequence?)",
    "Séquence publiée pas encore prête sur l'instance : réessayez plus tard": "Published sequence not ready on the instance yet: try again later",
    "Séquence ni publiée ni associée sur cette instance": "Sequence neither published nor linked on this instance",
    "{n} correction(s) refusée(s) : {e}": "{n} correction(s) rejected: {e}",
    "Aucune correction envoyée à remettre": "No sent correction to restore",
    "{n} photo(s) non remise(s) : {e}": "{n} photo(s) not restored: {e}",
    "Identifiant de séquence introuvable : {c}": "Sequence identifier not found: {c}",
    "Choisissez au moins une séquence": "Choose at least one sequence",
    "Ce projet est lié à une autre instance que celle où vous êtes connecté": "This project is linked to another instance than the one you are signed in to",
    "Image indisponible sur l'instance (erreur {code})": "Image unavailable on the instance (error {code})",
    "séquence importée de Panoramax": "sequence imported from Panoramax",
    # exporter.py / importer.py / jobs.py
    "Le dossier {path} existe déjà et n'est pas un export de ce projet": "Folder {path} already exists and is not an export of this project",
    "Le dossier {path} contient l'export d'un autre projet": "Folder {path} contains another project's export",
    "Un fichier existe déjà : {dest}": "A file already exists: {dest}",
    "Mode inconnu : {mode}": "Unknown mode: {mode}",
    "Fichier source introuvable : {p}": "Source file not found: {p}",
    "{n} fichier(s) en échec de vérification (voir l'historique des exports)": "{n} file(s) failed verification (see the export history)",
    "{n} photo(s) non déplacée(s), par ex. {e}": "{n} photo(s) not moved, e.g. {e}",
    "Annulé": "Cancelled",
    "Recherche des photos…": "Looking for photos…",
    "{n} nouvelles photos ({m} déjà importées)": "{n} new photos ({m} already imported)",
    "Lecture des métadonnées…": "Reading metadata…",
    "Analyse…": "Analysing…",
    "Import terminé": "Import finished",
    "Génération des miniatures…": "Generating thumbnails…",
    "Miniatures terminées": "Thumbnails finished",
    "{n} fichier(s) introuvable(s)": "{n} file(s) not found",
    "Préparation de l'export…": "Preparing the export…",
    "Sauvegarde des métadonnées d'origine (« {name} »)": "Saving original metadata (\"{name}\")",
    "Déplacement des photos de « {name} »": "Moving the photos of \"{name}\"",
    "Export de « {name} »": "Exporting \"{name}\"",
    "{n} séquence(s) exportée(s){w}": "{n} sequence(s) exported{w}",
    "Déplacement des photos exclues…": "Moving excluded photos…",
    "{n} photo(s) exclue(s) déplacée(s) dans {d}": "{n} excluded photo(s) moved to {d}",
    "Restauration des photos sources…": "Restoring source photos…",
    "{n} photo(s) restaurée(s)": "{n} photo(s) restored",
    ", {n} en échec": ", {n} failed",
    " — {n} problème(s)": " — {n} problem(s)",
    "Réexport de « {name} » avant publication": "Re-exporting \"{name}\" before publication",
    "{p}Envoi de « {name} » sur Panoramax": "{p}Sending \"{name}\" to Panoramax",
    "{p}« {name} » : traitement par Panoramax (floutage…)": "{p}\"{name}\": processing by Panoramax (blurring…)",
    "Envoi des corrections sur Panoramax": "Sending corrections to Panoramax",
    "Suppression des photos exclues sur Panoramax": "Deleting excluded photos on Panoramax",
    "{a} photo(s) corrigée(s), {b} supprimée(s) sur Panoramax": "{a} photo(s) corrected, {b} deleted on Panoramax",
    "Valeurs d'avant remises sur Panoramax": "Previous values restored on Panoramax",
    "Lecture de « {title} » ({n}/{m})": "Reading \"{title}\" ({n}/{m})",
    "{n} photo(s) importée(s) de Panoramax": "{n} photo(s) imported from Panoramax",
    # core/
    "Pas de trace GPS autour de cette photo": "No GPS track around this photo",
    "Pas de trace GPS exploitable": "No usable GPS track",
    "OpenStreetMap (Overpass) injoignable : {e}": "OpenStreetMap (Overpass) unreachable: {e}",
    "Fichier GPX illisible : {e}": "Unreadable GPX file: {e}",
    "Aucun point horodaté dans ce fichier GPX (une trace enregistrée est nécessaire, pas un itinéraire)":
        "No timestamped point in this GPX file (a recorded track is needed, not a route)",
    "Aucune photo sélectionnée": "No photo selected",
    "Coordonnées invalides": "Invalid coordinates",
    "La plage contient des photos déjà classées ({e})": "The range contains photos already in a sequence ({e})",
    "Aucune photo utilisable dans cette plage": "No usable photo in this range",
    "La nouvelle plage chevauche une autre séquence": "The new range overlaps another sequence",
    "La photo n'appartient pas à cette séquence": "The photo does not belong to this sequence",
    "Impossible de couper avant la première photo": "Cannot cut before the first photo",
    "Sélectionnez au moins deux séquences": "Select at least two sequences",
    "Seules des séquences voisines peuvent être fusionnées": "Only neighbouring sequences can be merged",
    "Aucune photo utilisable autour de cette photo": "No usable photo around this photo",
    "Aucune photo non classée utilisable": "No usable unsequenced photo",
    # undo labels
    "Création de séquence": "Sequence creation",
    "Création de {n} séquences": "Creation of {n} sequences",
    "Renommage de séquence": "Sequence renamed",
    "Modification des limites": "Limits changed",
    "Suppression de séquence": "Sequence deleted",
    "Division de séquence": "Sequence split",
    "Fusion de séquences": "Sequences merged",
    "Retrait de photos": "Photos removed",
    "Séquences créées avec les photos non classées": "Sequences created from unsequenced photos",
    "Découpe": "Cut",
    "Exclusion de {n} photo(s)": "Exclusion of {n} photo(s)",
    "Réintégration de {n} photo(s)": "Reinstatement of {n} photo(s)",
    "Cap manuel": "Manual heading",
    "Retour au cap calculé": "Back to computed heading",
    "Cap gardé": "Heading kept",
    "Cap à nouveau signalé": "Heading flagged again",
    "Rotation de {a}° de {n} photo(s)": "Rotation of {a}° of {n} photo(s)",
    "Sens de déplacement fixé ({v}°) sur {n} photo(s)": "Travel direction set ({v}°) on {n} photo(s)",
    "Lacet remis à 0 sur {n} photo(s)": "Yaw reset to 0 on {n} photo(s)",
    "Décalage de cap {v}° sur une plage": "Heading offset {v}° on a range",
    "Cap {v}° sur une plage": "Heading {v}° on a range",
    "Retour au cap calculé sur une plage": "Back to computed heading on a range",
    "Décalage du cap {v}° ({w})": "Heading offset {v}° ({w})",
    "Décalage du cap retiré ({w})": "Heading offset removed ({w})",
    "Position corrigée": "Position corrected",
    "Retour à la position d'origine": "Back to original position",
    "Déplacement de {n} positions de {m} m le long du trajet": "Moved {n} positions by {m} m along the route",
    "Positions d'origine pour {n} photos": "Original positions for {n} photos",
    "Interpolation de {n} positions": "Interpolation of {n} positions",
    "Recalage sur OpenStreetMap ({n} tronçon(s))": "Snapping to OpenStreetMap ({n} section(s))",
    "Recalage sur la trace GPX (photos {a} → {b})": "Snapping to the GPX track (photos {a} → {b})",
    "Synchronisation {o} s {w}": "Synchronisation {o} s {w}",
    "sur {w}": "on {w}",
    "une plage": "a range",
    "photos {a} → {b}": "photos {a} → {b}",
}
# Fragments that may stand alone inside undo labels
EN.update({"toute la sortie": "the whole ride", "toutes les photos": "all photos"})

_EXACT = {k: v for k, v in EN.items() if "{" not in k}
_TEMPLATES: list[tuple[re.Pattern, str]] = []
for _fr, _en in EN.items():
    if "{" in _fr:
        _rx = "".join(f"(?P<{p[1:-1]}>.+?)" if p.startswith("{") else re.escape(p) for p in re.split(r"(\{\w+\})", _fr) if p)
        _TEMPLATES.append((re.compile(_rx + r"\Z", re.S), _en))
# the most specific templates (most literal text) first
_TEMPLATES.sort(key=lambda t: -len(re.sub(r"\(\?P<\w+>\.\+\?\)", "", t[0].pattern)))


def set_lang(header: str | None) -> None:
    """Keep 'en' when the header's first language is English; French otherwise (default)."""
    first = (header or "").split(",")[0].strip().lower()
    _lang.set("en" if first.startswith("en") else "fr")


def lang() -> str:
    return _lang.get()


def tr(text, **params) -> str:
    """English version of a French message (when the current language is English), then `.format(**params)`."""
    if not isinstance(text, str):
        return text
    out = text
    if lang() == "en":
        out = _translate(text)
    return out.format(**params) if params else out


def _translate(text: str) -> str:
    if text in _EXACT:
        return _EXACT[text]
    for rx, en in _TEMPLATES:
        m = rx.match(text)
        if m:
            args = {k: _translate(v) for k, v in m.groupdict().items()}
            try:
                return en.format(**args)
            except (KeyError, IndexError):
                return text
    return text


class LangMiddleware:
    """ASGI middleware: reads Accept-Language for the duration of the request."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            hdr = dict(scope.get("headers") or []).get(b"accept-language", b"").decode("latin-1")
            set_lang(hdr)
        await self.app(scope, receive, send)
