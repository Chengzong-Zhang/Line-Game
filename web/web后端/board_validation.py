"""Pure validation and canonicalization for board-definition-v1 room inputs.

This module deliberately has no server, database, websocket, or mutable-room
dependencies. Callers can validate an untrusted definition before deciding
whether to replace any live match configuration.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping
from copy import deepcopy
from decimal import Decimal
import hashlib
import json
import math
import re
from typing import Any


BOARD_DEFINITION_SCHEMA_VERSION = 1
BOARD_DEFINITION_COORDINATE_SYSTEM = "triangular-axial-v1"
CANONICAL_HASH_SCHEMA_VERSION = "board-hash-v1"
SURFACE_RULES_VERSION = "surface-v1"
TOPOLOGY_BOARD_SHAPE = "custom"
TOPOLOGY_ROOM_PROTOCOL_VERSION = "board-topology-v1"

DEFAULT_LIMITS = {
    "maxBytes": 1_048_576,
    "maxVertices": 1_024,
    "maxFaces": 2_048,
    "maxEdgeOccurrences": 4_096,
    "maxSeamPairs": 512,
    "maxStarts": 6,
    "maxSamples": 4_096,
    "coordinateAbs": 32_768,
}

_TOPOLOGY_KEYS = (
    "family",
    "movementStrategy",
    "territoryStrategy",
    "specialVertexPolicy",
)
_TRIANGULAR_UNIT_DIRECTIONS = frozenset({
    (1, 0),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (0, -1),
    (1, -1),
})
_PROTOCOL_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:,_-]{0,127}$")


class _UnionFind:
    def __init__(self, values: list[str]) -> None:
        self._parent = {value: value for value in values}

    def find(self, value: str) -> str:
        parent = self._parent[value]
        while parent != self._parent[parent]:
            parent = self._parent[parent]
        while value != parent:
            next_value = self._parent[value]
            self._parent[value] = parent
            value = next_value
        return parent

    def union(self, left: str, right: str) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return
        if left_root < right_root:
            self._parent[right_root] = left_root
        else:
            self._parent[left_root] = right_root


def _error(errors: list[dict[str, str]], code: str, location: str, detail: str) -> None:
    errors.append({"code": code, "location": location, "detail": detail})


def _is_int(value: Any) -> bool:
    return type(value) is int


def _is_protocol_identifier(value: Any) -> bool:
    """Whether an internal board identifier is safe for cross-language order.

    Identifiers are protocol tokens, not player-facing labels.  Keeping them
    ASCII prevents locale-dependent JavaScript sorting from producing a
    different canonical payload or board hash from the Python room validator.
    """

    return isinstance(value, str) and _PROTOCOL_IDENTIFIER.fullmatch(value) is not None


def _has_protocol_safe_object_keys(value: Any) -> bool:
    """Recursively constrain only object keys in optional generator metadata."""

    if value is None or isinstance(value, (bool, int, float, str)):
        return True
    if isinstance(value, list):
        return all(_has_protocol_safe_object_keys(item) for item in value)
    if isinstance(value, Mapping):
        return all(
            _is_protocol_identifier(key) and _has_protocol_safe_object_keys(child)
            for key, child in value.items()
        )
    return False


def _js_number(value: float) -> str:
    """Serialize a finite Python float with JSON.stringify-compatible thresholds."""

    if not math.isfinite(value):
        return "null"
    if value == 0:
        return "0"
    absolute = abs(value)
    if 1e-6 <= absolute < 1e21:
        fixed = format(Decimal(repr(value)), "f")
        if "." in fixed:
            fixed = fixed.rstrip("0").rstrip(".")
        return fixed
    rendered = repr(value).lower()
    if "e" not in rendered:
        rendered = format(value, ".15e")
    mantissa, exponent = rendered.split("e")
    mantissa = mantissa.rstrip("0").rstrip(".")
    return mantissa + "e" + ("+" if int(exponent) >= 0 else "-") + str(abs(int(exponent)))


def _stable_json(value: Any) -> str:
    """The same recursive, sorted-key JSON text as BoardDefinition.stableStringify."""

    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if _is_int(value):
        return str(value)
    if isinstance(value, float):
        return _js_number(value)
    if isinstance(value, list):
        return "[" + ",".join(_stable_json(item) for item in value) + "]"
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("JSON object keys must be strings.")
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False, separators=(",", ":")) + ":" + _stable_json(value[key])
            for key in sorted(value)
        ) + "}"
    raise TypeError("Unsupported JSON value.")


def _json_copy(value: Any) -> Any:
    return json.loads(_stable_json(value))


def _normalise_limits(limits: Mapping[str, Any] | None) -> dict[str, int]:
    result = dict(DEFAULT_LIMITS)
    if not isinstance(limits, Mapping):
        return result
    for key in DEFAULT_LIMITS:
        value = limits.get(key)
        if _is_int(value) and value > 0:
            result[key] = value
    return result


def _decode_raw(raw: Any, max_json_bytes: int, errors: list[dict[str, str]]) -> Mapping[str, Any] | None:
    if isinstance(raw, bytes):
        if len(raw) > max_json_bytes:
            _error(errors, "LIMIT_EXCEEDED", "$", "The serialized board definition exceeds maxJsonBytes.")
            return None
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError:
            _error(errors, "INVALID_JSON", "$", "The serialized board definition is not UTF-8.")
            return None
    if isinstance(raw, str):
        if len(raw.encode("utf-8")) > max_json_bytes:
            _error(errors, "LIMIT_EXCEEDED", "$", "The serialized board definition exceeds maxJsonBytes.")
            return None
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError):
            _error(errors, "INVALID_JSON", "$", "The board definition is not valid JSON.")
            return None
    if not isinstance(raw, Mapping):
        _error(errors, "INVALID_DEFINITION", "$", "The board definition must be a JSON object.")
        return None
    try:
        if len(_stable_json(raw).encode("utf-8")) > max_json_bytes:
            _error(errors, "LIMIT_EXCEEDED", "$", "The serialized board definition exceeds maxJsonBytes.")
            return None
    except (TypeError, ValueError):
        _error(errors, "INVALID_JSON", "$", "The board definition contains a non-JSON value.")
        return None
    return raw


def _edge_key(left: str, right: str) -> tuple[str, str]:
    return (left, right) if left < right else (right, left)


def _signed_area_twice(first: list[int], second: list[int], third: list[int]) -> int:
    return ((second[0] - first[0]) * (third[1] - first[1])
            - (second[1] - first[1]) * (third[0] - first[0]))


def _is_unit_triangular_edge(first: list[int], second: list[int]) -> bool:
    return (second[0] - first[0], second[1] - first[1]) in _TRIANGULAR_UNIT_DIRECTIONS


def _is_endpoint_map(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and all(_is_int(item) for item in value)
        and value in ([0, 1], [1, 0])
    )


def _canonical_payload(definition: Mapping[str, Any]) -> dict[str, Any]:
    """Return exactly the gameplay-relevant portion used for boardHash."""

    return {
        "hashSchemaVersion": CANONICAL_HASH_SCHEMA_VERSION,
        "definition": definition,
    }


def validate_board_definition(raw: Any, limits: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Validate a board-definition-v1 JSON value without side effects."""

    errors: list[dict[str, str]] = []
    active_limits = _normalise_limits(limits)
    source = _decode_raw(raw, active_limits["maxBytes"], errors)
    if source is None:
        return {"ok": False, "errors": errors}

    if source.get("schemaVersion") != BOARD_DEFINITION_SCHEMA_VERSION:
        _error(errors, "UNSUPPORTED_SCHEMA", "$.schemaVersion", "schemaVersion must be the integer 1.")
    if source.get("coordinateSystem") != BOARD_DEFINITION_COORDINATE_SYSTEM:
        _error(
            errors,
            "INVALID_COORDINATE_SYSTEM",
            "$.coordinateSystem",
            "coordinateSystem must be triangular-axial-v1.",
        )

    topology_raw = source.get("topology")
    topology: dict[str, str] = {}
    if not isinstance(topology_raw, Mapping) or topology_raw.get("family") not in {"planar", "surface"}:
        _error(errors, "INVALID_TOPOLOGY", "$.topology.family", "Expected planar or surface.")
    else:
        topology = {
            "family": topology_raw["family"],
            "movementStrategy": topology_raw.get("movementStrategy", "simple-rays-v1"),
            "territoryStrategy": topology_raw.get("territoryStrategy", "surface-discrete-v1"),
            "specialVertexPolicy": topology_raw.get("specialVertexPolicy", "stop"),
        }
        if isinstance(topology_raw.get("preset"), str):
            topology["preset"] = topology_raw["preset"]
        if not all(isinstance(value, str) and value for value in topology.values()):
            _error(errors, "INVALID_TOPOLOGY", "$.topology", "Topology values must be non-empty strings.")

    scoring_raw = source.get("scoring")
    scoring: dict[str, Any] = {"strategy": "canonical-vertices-v1"}
    if scoring_raw is not None:
        if not isinstance(scoring_raw, Mapping) or (
            scoring_raw.get("strategy") is not None
            and scoring_raw.get("strategy") != "canonical-vertices-v1"
        ):
            _error(errors, "INVALID_SCORING", "$.scoring", "Expected canonical-vertices-v1.")
        else:
            if scoring_raw.get("weights") is not None and not isinstance(scoring_raw.get("weights"), Mapping):
                _error(errors, "INVALID_SAMPLE_WEIGHT", "$.scoring.weights", "Expected an object.")
            else:
                scoring = {"strategy": scoring_raw.get("strategy", "canonical-vertices-v1")}

    vertices_raw = source.get("vertices")
    vertices: list[dict[str, Any]] = []
    coordinates_by_id: dict[str, list[int]] = {}
    if not isinstance(vertices_raw, list):
        _error(errors, "INVALID_VERTICES", "$.vertices", "vertices must be an array.")
    else:
        if len(vertices_raw) > active_limits["maxVertices"]:
            _error(errors, "LIMIT_EXCEEDED", "$.vertices", "vertices exceeds maxVertices.")
        vertex_ids: set[str] = set()
        coordinate_ids: set[tuple[int, int]] = set()
        for index, vertex in enumerate(vertices_raw):
            location = "$.vertices[" + str(index) + "]"
            if not isinstance(vertex, Mapping):
                _error(errors, "INVALID_VERTEX", location, "A vertex must be an object.")
                continue
            identifier = vertex.get("id")
            coordinate = vertex.get("coordinate")
            if not _is_protocol_identifier(identifier):
                _error(
                    errors,
                    "INVALID_VERTEX_ID",
                    location + ".id",
                    "Vertex id must use the board-topology ASCII identifier grammar.",
                )
                continue
            if identifier in vertex_ids:
                _error(errors, "DUPLICATE_VERTEX_ID", location + ".id", "Vertex identifiers must be unique.")
                continue
            vertex_ids.add(identifier)
            if not (
                isinstance(coordinate, list)
                and len(coordinate) == 2
                and all(_is_int(value) for value in coordinate)
                and all(abs(value) <= active_limits["coordinateAbs"] for value in coordinate)
            ):
                _error(errors, "INVALID_COORDINATE", location + ".coordinate", "Coordinates must be two bounded integers.")
                continue
            coordinate_key = (coordinate[0], coordinate[1])
            if coordinate_key in coordinate_ids:
                _error(errors, "DUPLICATE_VERTEX_COORDINATE", location + ".coordinate", "Coordinates must be unique.")
                continue
            coordinate_ids.add(coordinate_key)
            normalized_coordinate = [coordinate[0], coordinate[1]]
            coordinates_by_id[identifier] = normalized_coordinate
            vertices.append({"id": identifier, "coordinate": normalized_coordinate})

    if isinstance(scoring_raw, Mapping) and isinstance(scoring_raw.get("weights"), Mapping):
        weights: dict[str, int] = {}
        for vertex_id, weight in scoring_raw["weights"].items():
            if not isinstance(vertex_id, str) or vertex_id not in coordinates_by_id or not _is_int(weight) or weight <= 0:
                _error(
                    errors,
                    "INVALID_SAMPLE_WEIGHT",
                    "$.scoring.weights." + str(vertex_id),
                    str(weight),
                )
            else:
                weights[vertex_id] = weight
        scoring["weights"] = weights

    faces_raw = source.get("faces")
    faces: list[dict[str, Any]] = []
    edge_occurrences: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    occurrence_by_id: dict[str, dict[str, Any]] = {}
    graph: dict[str, set[str]] = {identifier: set() for identifier in coordinates_by_id}
    if not isinstance(faces_raw, list):
        _error(errors, "INVALID_FACES", "$.faces", "faces must be an array.")
    else:
        if len(faces_raw) > active_limits["maxFaces"]:
            _error(errors, "LIMIT_EXCEEDED", "$.faces", "faces exceeds maxFaces.")
        face_ids: set[str] = set()
        seen_face_vertex_sets: set[str] = set()
        for index, face in enumerate(faces_raw):
            location = "$.faces[" + str(index) + "]"
            if not isinstance(face, Mapping):
                _error(errors, "INVALID_FACE", location, "A face must be an object.")
                continue
            identifier = face.get("id")
            face_vertex_ids = face.get("vertices")
            if not _is_protocol_identifier(identifier):
                _error(
                    errors,
                    "INVALID_FACE_ID",
                    location + ".id",
                    "Face id must use the board-topology ASCII identifier grammar.",
                )
                continue
            if identifier in face_ids:
                _error(errors, "DUPLICATE_FACE_ID", location + ".id", "Face identifiers must be unique.")
                continue
            face_ids.add(identifier)
            if not isinstance(face_vertex_ids, list) or len(face_vertex_ids) != 3 or not all(
                isinstance(vertex_id, str) for vertex_id in face_vertex_ids
            ):
                _error(errors, "DEGENERATE_FACE", location + ".vertices", "A v1 face needs three vertex identifiers.")
                continue
            if len(set(face_vertex_ids)) != 3:
                _error(errors, "DEGENERATE_FACE", location + ".vertices", "A face cannot repeat a vertex.")
                continue
            unknown_vertex = next((vertex_id for vertex_id in face_vertex_ids if vertex_id not in coordinates_by_id), None)
            if unknown_vertex is not None:
                _error(errors, "UNKNOWN_FACE_VERTEX", location + ".vertices", "Face references " + unknown_vertex + ".")
                continue
            if _signed_area_twice(
                coordinates_by_id[face_vertex_ids[0]],
                coordinates_by_id[face_vertex_ids[1]],
                coordinates_by_id[face_vertex_ids[2]],
            ) == 0:
                _error(errors, "DEGENERATE_FACE", location + ".vertices", "Face vertices must not be collinear.")
                continue
            for side_index, vertex_id in enumerate(face_vertex_ids):
                next_vertex_id = face_vertex_ids[(side_index + 1) % len(face_vertex_ids)]
                if not _is_unit_triangular_edge(
                    coordinates_by_id[vertex_id],
                    coordinates_by_id[next_vertex_id],
                ):
                    _error(
                        errors,
                        "NON_UNIT_TRIANGULAR_EDGE",
                        location + ".vertices[" + str(side_index) + "]",
                        vertex_id + "->" + next_vertex_id,
                    )
            face_set_key = "|".join(sorted(face_vertex_ids))
            if face_set_key in seen_face_vertex_sets:
                _error(errors, "DUPLICATE_FACE", location + ".vertices", face_set_key)
                continue
            seen_face_vertex_sets.add(face_set_key)
            normalized_face = {"id": identifier, "vertices": list(face_vertex_ids)}
            faces.append(normalized_face)
            for side_index, left in enumerate(face_vertex_ids):
                right = face_vertex_ids[(side_index + 1) % 3]
                occurrence = {
                    "id": identifier + ":" + str(side_index),
                    "faceId": identifier,
                    "sideIndex": side_index,
                    "vertices": [left, right],
                }
                occurrence_by_id[occurrence["id"]] = occurrence
                edge_occurrences[_edge_key(left, right)].append(occurrence)
                graph[left].add(right)
                graph[right].add(left)

    if len(occurrence_by_id) > active_limits["maxEdgeOccurrences"]:
        _error(errors, "LIMIT_EXCEEDED", "$.faces", "Face edge occurrences exceed maxEdgeOccurrences.")
    for edge, occurrences in edge_occurrences.items():
        if len(occurrences) > 2:
            _error(
                errors,
                "NON_MANIFOLD_EDGE",
                "$.faces",
                "Edge " + "|".join(edge) + " occurs in more than two faces.",
            )


    seam_pairs_raw = source.get("seamPairs", [])
    seam_pairs: list[dict[str, Any]] = []
    used_occurrences: set[str] = set()
    if not isinstance(seam_pairs_raw, list):
        _error(errors, "INVALID_SEAM_PAIRS", "$.seamPairs", "seamPairs must be an array.")
    else:
        if len(seam_pairs_raw) > active_limits["maxSeamPairs"]:
            _error(errors, "LIMIT_EXCEEDED", "$.seamPairs", "seamPairs exceeds maxSeamPairs.")
        seam_ids: set[str] = set()
        for index, pair in enumerate(seam_pairs_raw):
            location = "$.seamPairs[" + str(index) + "]"
            if not isinstance(pair, Mapping):
                _error(errors, "INVALID_SEAM_PAIR", location, "A seam pair must be an object.")
                continue
            identifier = pair.get("id")
            first_occurrence_id = pair.get("edgeOccurrenceA")
            second_occurrence_id = pair.get("edgeOccurrenceB")
            endpoint_map = pair.get("endpointMap")
            if not _is_protocol_identifier(identifier):
                _error(
                    errors,
                    "INVALID_SEAM_ID",
                    location + ".id",
                    "Seam id must use the board-topology ASCII identifier grammar.",
                )
                continue
            if identifier in seam_ids:
                _error(errors, "DUPLICATE_SEAM_ID", location + ".id", "Seam identifiers must be unique.")
                continue
            seam_ids.add(identifier)
            if not _is_endpoint_map(endpoint_map):
                _error(errors, "INVALID_ENDPOINT_MAP", location + ".endpointMap", "endpointMap must be [0,1] or [1,0].")
                continue
            if not isinstance(first_occurrence_id, str) or first_occurrence_id not in occurrence_by_id:
                _error(errors, "UNKNOWN_EDGE_OCCURRENCE", location + ".edgeOccurrenceA", "Unknown first edge occurrence.")
                continue
            if not isinstance(second_occurrence_id, str) or second_occurrence_id not in occurrence_by_id:
                _error(errors, "UNKNOWN_EDGE_OCCURRENCE", location + ".edgeOccurrenceB", "Unknown second edge occurrence.")
                continue
            if first_occurrence_id == second_occurrence_id:
                _error(errors, "SELF_SEAM", location, "An edge occurrence cannot be paired with itself.")
                continue
            first_occurrence = occurrence_by_id[first_occurrence_id]
            second_occurrence = occurrence_by_id[second_occurrence_id]
            if len(edge_occurrences[_edge_key(*first_occurrence["vertices"])]) != 1:
                _error(errors, "SEAM_REQUIRES_BOUNDARY_EDGE", location + ".edgeOccurrenceA", "Only boundary occurrences can be paired.")
                continue
            if len(edge_occurrences[_edge_key(*second_occurrence["vertices"])]) != 1:
                _error(errors, "SEAM_REQUIRES_BOUNDARY_EDGE", location + ".edgeOccurrenceB", "Only boundary occurrences can be paired.")
                continue
            if first_occurrence_id in used_occurrences or second_occurrence_id in used_occurrences:
                _error(errors, "DUPLICATE_SEAM_OCCURRENCE", location, "Each boundary occurrence can participate in one pair.")
                continue
            used_occurrences.add(first_occurrence_id)
            used_occurrences.add(second_occurrence_id)
            seam_pairs.append(
                {
                    "id": identifier,
                    "edgeOccurrenceA": first_occurrence_id,
                    "edgeOccurrenceB": second_occurrence_id,
                    "endpointMap": list(endpoint_map),
                }
            )

    starts_raw = source.get("startingVertices")
    starts_present = starts_raw is not None
    starts: dict[str, Any] = {}
    if starts_present and not isinstance(starts_raw, Mapping):
        _error(errors, "INVALID_STARTING_VERTICES", "$.startingVertices", "startingVertices must be an object.")
    elif starts_present:
        if len(starts_raw) > active_limits["maxStarts"]:
            _error(errors, "LIMIT_EXCEEDED", "$.startingVertices", "Too many players.")
        used_starts = set()
        for player, raw_value in sorted(starts_raw.items(), key=lambda item: str(item[0])):
            location = "$.startingVertices." + str(player)
            if not _is_protocol_identifier(player):
                _error(errors, "INVALID_STARTING_PLAYER_ID", location, "Invalid player id."); continue
            values = raw_value if isinstance(raw_value, list) else [raw_value]
            if not values or len(values) > active_limits["maxStarts"]:
                _error(errors, "INVALID_STARTING_VERTICES", location, "Expected one to six starts."); continue
            valid = True
            for vertex_id in values:
                if not isinstance(vertex_id, str) or vertex_id not in coordinates_by_id:
                    _error(errors, "UNKNOWN_START_VERTEX", location, "Unknown start vertex."); valid = False
                elif vertex_id in used_starts:
                    _error(errors, "DUPLICATE_START_VERTEX", location, "Starting vertices must be distinct."); valid = False
                else:
                    used_starts.add(vertex_id)
            if valid:
                starts[player] = sorted(values) if isinstance(raw_value, list) else values[0]

    if isinstance(source.get("generator"), Mapping) and not _has_protocol_safe_object_keys(source["generator"]):
        _error(
            errors,
            "INVALID_GENERATOR_KEY",
            "$.generator",
            "Generator object keys must use the board-topology ASCII identifier grammar.",
        )

    if errors:
        return {"ok": False, "errors": errors}

    normalized: dict[str, Any] = {
        "schemaVersion": BOARD_DEFINITION_SCHEMA_VERSION,
        "coordinateSystem": BOARD_DEFINITION_COORDINATE_SYSTEM,
        "topology": topology,
        "vertices": sorted(vertices, key=lambda vertex: vertex["id"]),
        "faces": sorted(faces, key=lambda face: face["id"]),
        "seamPairs": sorted(seam_pairs, key=lambda pair: pair["id"]),
        "scoring": {
            "strategy": scoring["strategy"],
            **({"weights": dict(sorted(scoring["weights"].items()))} if "weights" in scoring else {}),
        },
    }
    if starts_present:
        normalized["startingVertices"] = dict(sorted(starts.items()))
    if isinstance(source.get("generator"), Mapping):
        try:
            normalized["generator"] = _json_copy(source["generator"])
        except (TypeError, ValueError):
            return {
                "ok": False,
                "errors": [{
                    "code": "INVALID_JSON",
                    "location": "$.generator",
                    "detail": "generator must contain only JSON values.",
                }],
            }
    return {"ok": True, "value": normalized, "errors": []}


def canonicalize_board_definition(raw: Any, limits: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Validate a definition and produce deterministic gameplay JSON and SHA-256."""

    validation = validate_board_definition(raw, limits)
    if not validation["ok"]:
        return {"ok": False, "errors": validation["errors"]}
    definition = validation["value"]
    canonical_json = _stable_json(_canonical_payload(definition))
    return {
        "ok": True,
        "definition": deepcopy(definition),
        "canonicalJson": canonical_json,
        "boardHash": hashlib.sha256(canonical_json.encode("utf-8")).hexdigest(),
        "errors": [],
    }


def topology_settings_requested(settings: Any) -> bool:
    """Whether untrusted room settings ask for the topology protocol.

    This deliberately treats a partial topology request as topology rather than
    silently falling through to a legacy triangle/hexagon room.  The server
    uses it before applying legacy defaults so malformed custom-board requests
    fail closed.
    """

    return isinstance(settings, Mapping) and (
        settings.get("rulesVersion") == SURFACE_RULES_VERSION
        or settings.get("boardShape") == TOPOLOGY_BOARD_SHAPE
        or "boardDefinition" in settings
        or "boardHash" in settings
    )


def _room_error(errors: list[dict[str, str]], code: str, location: str, detail: str) -> None:
    errors.append({"code": code, "location": location, "detail": detail})


def _topology_quotient_analysis(definition: Mapping[str, Any]) -> dict[str, Any]:
    """Reproduce the compile-time quotient checks required by Web clients.

    ``validate_board_definition`` deliberately accepts a syntactically valid
    pair of boundary occurrences.  A room, however, must not be fixed to a
    quotient that ``compileBoard`` will reject.  This bounded implementation
    mirrors the Web checks that matter for the room contract: quotient-edge
    collapse and conflicting quotient weights. Non-manifold vertex links are classified by clients as special vertices.
    It does not try to act as a game engine or a second renderer.
    """

    vertex_ids = [vertex["id"] for vertex in definition["vertices"]]
    vertex_union = _UnionFind(vertex_ids)
    occurrences: dict[str, dict[str, Any]] = {}
    occurrences_by_raw_edge: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for face in definition["faces"]:
        face_vertices = face["vertices"]
        for side_index, left in enumerate(face_vertices):
            right = face_vertices[(side_index + 1) % len(face_vertices)]
            occurrence = {
                "id": face["id"] + ":" + str(side_index),
                "faceId": face["id"],
                "sideIndex": side_index,
                "vertices": [left, right],
            }
            occurrences[occurrence["id"]] = occurrence
            occurrences_by_raw_edge[_edge_key(left, right)].append(occurrence)

    for pair in definition["seamPairs"]:
        first = occurrences[pair["edgeOccurrenceA"]]
        second = occurrences[pair["edgeOccurrenceB"]]
        endpoint_map = pair["endpointMap"]
        vertex_union.union(first["vertices"][0], second["vertices"][endpoint_map[0]])
        vertex_union.union(first["vertices"][1], second["vertices"][endpoint_map[1]])

    raw_to_quotient = {vertex_id: vertex_union.find(vertex_id) for vertex_id in vertex_ids}
    quotient_members: dict[str, list[str]] = defaultdict(list)
    for vertex_id, quotient_id in raw_to_quotient.items():
        quotient_members[quotient_id].append(vertex_id)

    occurrence_union = _UnionFind(list(occurrences))
    for edge_occurrences in occurrences_by_raw_edge.values():
        if len(edge_occurrences) == 2:
            occurrence_union.union(edge_occurrences[0]["id"], edge_occurrences[1]["id"])
    for pair in definition["seamPairs"]:
        occurrence_union.union(pair["edgeOccurrenceA"], pair["edgeOccurrenceB"])

    edge_class_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for occurrence in occurrences.values():
        edge_class_groups[occurrence_union.find(occurrence["id"])].append(occurrence)
    edge_classes = sorted(
        (sorted(group, key=lambda occurrence: occurrence["id"]) for group in edge_class_groups.values()),
        key=lambda group: group[0]["id"],
    )
    edge_class_by_occurrence: dict[str, str] = {}
    for index, edge_class in enumerate(edge_classes):
        class_id = "ce:" + str(index)
        for occurrence in edge_class:
            edge_class_by_occurrence[occurrence["id"]] = class_id

    errors: list[dict[str, str]] = []
    for index, edge_class in enumerate(edge_classes):
        first = edge_class[0]
        left, right = (raw_to_quotient[vertex_id] for vertex_id in first["vertices"])
        if left == right:
            _error(
                errors,
                "DEGENERATE_QUOTIENT_EDGE",
                "edgeClasses.ce:" + str(index),
                "A glued edge has identical canonical endpoints.",
            )

    raw_weights = definition.get("scoring", {}).get("weights", {})
    for quotient_id, source_vertex_ids in quotient_members.items():
        weights = {raw_weights.get(vertex_id, 1) for vertex_id in source_vertex_ids}
        if len(weights) > 1:
            _error(
                errors,
                "CONFLICTING_CANONICAL_WEIGHT",
                "scoring.weights." + quotient_id,
                "Vertices merged by a seam must have identical sample weights.",
            )


    return {
        "errors": errors,
        "rawToQuotient": raw_to_quotient,
        "canonicalVertexCount": len(quotient_members),
    }


def _canonical_start_vertices(definition: Mapping[str, Any]) -> dict[str, list[str]]:
    """Return every quotient representative for each source root."""
    analysis = _topology_quotient_analysis(definition)
    return {player: [analysis["rawToQuotient"][vertex_id] for vertex_id in
                     (value if isinstance(value, list) else [value])]
            for player, value in definition.get("startingVertices", {}).items()}


def topology_canonical_vertex_ids(definition: Any) -> frozenset[str]:
    """Return exactly the canonical ``cv:<index>`` IDs accepted by the room.

    The web compiler assigns a contiguous sequence after quotienting.  Server
    move forwarding need not reproduce locale-sensitive raw-to-index ordering:
    accepting this set rejects aliases, leading-zero forms and out-of-range
    canonical IDs while preserving the actual client wire contract.
    """

    canonical = canonicalize_board_definition(definition)
    if not canonical["ok"]:
        return frozenset()
    analysis = _topology_quotient_analysis(canonical["definition"])
    if analysis["errors"]:
        return frozenset()
    return frozenset("cv:" + str(index) for index in range(analysis["canonicalVertexCount"]))


def canonicalize_topology_room_settings(
    settings: Any,
    player_ids: list[str] | tuple[str, ...],
    limits: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate one custom-board room configuration without mutating a room.

    The return value intentionally contains the server-derived canonical board
    definition and hash.  A caller must never retain a client-provided hash.
    The definition must also carry every active player's starting vertex: this
    prevents the JavaScript engine from deterministically inventing starts
    after the room hash has already been fixed.
    """

    errors: list[dict[str, str]] = []
    if not isinstance(settings, Mapping):
        _room_error(errors, "INVALID_ROOM_SETTINGS", "$", "Room settings must be a JSON object.")
        return {"ok": False, "errors": errors}
    if not topology_settings_requested(settings):
        _room_error(errors, "NOT_TOPOLOGY_SETTINGS", "$", "Settings do not request the topology protocol.")
        return {"ok": False, "errors": errors}

    normalized_player_ids = list(player_ids) if isinstance(player_ids, (list, tuple)) else []
    if (
        not 2 <= len(normalized_player_ids) <= DEFAULT_LIMITS["maxStarts"]
        or any(not isinstance(player, str) or not player for player in normalized_player_ids)
        or len(set(normalized_player_ids)) != len(normalized_player_ids)
    ):
        _room_error(errors, "INVALID_ROOM_PLAYERS", "player_ids", "Expected two to six unique player identifiers.")

    if settings.get("rulesVersion") != SURFACE_RULES_VERSION:
        _room_error(errors, "UNSUPPORTED_TOPOLOGY_RULES_VERSION", "rulesVersion", SURFACE_RULES_VERSION)
    if settings.get("boardShape") != TOPOLOGY_BOARD_SHAPE:
        _room_error(errors, "INVALID_TOPOLOGY_BOARD_SHAPE", "boardShape", TOPOLOGY_BOARD_SHAPE)
    if "boardDefinition" not in settings:
        _room_error(errors, "MISSING_BOARD_DEFINITION", "boardDefinition", "A complete board definition is required.")
    # surface-v1 intentionally freezes the legacy single-root contract.  Do
    # not silently discard root-v2 fields here: that would make the same
    # boardHash mean two different games across reconnect/replay clients.
    if settings.get("rootMode", "classic") != "classic":
        _room_error(
            errors,
            "TOPOLOGY_ROOT_MODE_UNSUPPORTED",
            "rootMode",
            "Topology rooms only support classic root-v1 rules.",
        )
    if settings.get("rootRulesVersion", "root-v1") != "root-v1":
        _room_error(
            errors,
            "TOPOLOGY_ROOT_MODE_UNSUPPORTED",
            "rootRulesVersion",
            "Topology rooms only support classic root-v1 rules.",
        )
    if "initialRoots" in settings:
        _room_error(
            errors,
            "TOPOLOGY_ROOT_MODE_UNSUPPORTED",
            "initialRoots",
            "Topology rooms do not accept explicit root-v2 initialRoots.",
        )
    # The existing server-side bot bridge only understands legacy point moves
    # and legacy GameEngine rules.  Rejecting this request is safer than
    # accepting a map the bridge would later reinterpret as a default board.
    if settings.get("botCount", 0) != 0:
        _room_error(errors, "TOPOLOGY_BOTS_UNSUPPORTED", "botCount", "Topology rooms do not support server bots yet.")
    if errors:
        return {"ok": False, "errors": errors}

    canonical = canonicalize_board_definition(settings["boardDefinition"], limits)
    if not canonical["ok"]:
        return {"ok": False, "errors": canonical["errors"]}

    definition = canonical["definition"]
    quotient = _topology_quotient_analysis(definition)
    if quotient["errors"]:
        # A syntactically valid definition can still collapse an edge  Fail before
        # freezing a room that Web compileBoard would refuse to open.
        return {"ok": False, "errors": quotient["errors"]}
    starts = definition.get("startingVertices")
    expected_players = set(normalized_player_ids)
    if not isinstance(starts, Mapping):
        _room_error(errors, "MISSING_STARTING_VERTICES", "boardDefinition.startingVertices", "Every active player needs a fixed starting vertex.")
    elif set(starts) != expected_players:
        _room_error(errors, "STARTING_PLAYERS_MISMATCH", "boardDefinition.startingVertices", "Starting vertices must match the room players exactly.")
    else:
        quotient_starts = [quotient["rawToQuotient"][vertex_id]
            for value in starts.values() for vertex_id in (value if isinstance(value, list) else [value])]
        if len(set(quotient_starts)) != len(quotient_starts):
            _room_error(errors, "MERGED_STARTING_VERTICES", "boardDefinition.startingVertices", "Seam gluing merges starting vertices.")

    provided_hash = settings.get("boardHash")
    if provided_hash is not None and provided_hash != canonical["boardHash"]:
        _room_error(errors, "BOARD_HASH_MISMATCH", "boardHash", "The submitted hash does not match the canonical definition.")
    if errors:
        return {"ok": False, "errors": errors}

    room_settings = {
        "rulesVersion": SURFACE_RULES_VERSION,
        "boardShape": TOPOLOGY_BOARD_SHAPE,
        "boardDefinition": deepcopy(definition),
        "boardHash": canonical["boardHash"],
        "topologyProtocolVersion": TOPOLOGY_ROOM_PROTOCOL_VERSION,
        "rootMode": "classic",
        "rootRulesVersion": "root-v1",
    }
    return {
        "ok": True,
        "settings": room_settings,
        "definition": deepcopy(definition),
        "boardHash": canonical["boardHash"],
        "errors": [],
    }


__all__ = [
    "BOARD_DEFINITION_COORDINATE_SYSTEM",
    "BOARD_DEFINITION_SCHEMA_VERSION",
    "CANONICAL_HASH_SCHEMA_VERSION",
    "DEFAULT_LIMITS",
    "SURFACE_RULES_VERSION",
    "TOPOLOGY_BOARD_SHAPE",
    "TOPOLOGY_ROOM_PROTOCOL_VERSION",
    "canonicalize_board_definition",
    "canonicalize_topology_room_settings",
    "topology_canonical_vertex_ids",
    "topology_settings_requested",
    "validate_board_definition",
]
