"""Independent regression tests for board-definition-v1 server-side validation."""

from copy import deepcopy
from pathlib import Path
import sys
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "web后端"))
from board_validation import (
    SURFACE_RULES_VERSION,
    TOPOLOGY_BOARD_SHAPE,
    TOPOLOGY_ROOM_PROTOCOL_VERSION,
    canonicalize_board_definition,
    canonicalize_topology_room_settings,
    topology_canonical_vertex_ids,
    topology_settings_requested,
    validate_board_definition,
)


def _vertex_id(x, y):
    return "v:" + str(x) + "," + str(y)


def _make_patch(width=4, height=3, excluded=()):
    excluded = set(excluded)
    vertices = [
        {"id": _vertex_id(x, y), "coordinate": [x, y]}
        for y in range(height + 1)
        for x in range(width + 1)
        if (x, y) not in excluded
    ]
    faces = []

    def add_face(identifier, coordinates):
        if all(coordinate not in excluded for coordinate in coordinates):
            faces.append({"id": identifier, "vertices": [_vertex_id(*coordinate) for coordinate in coordinates]})

    for y in range(height):
        for x in range(width):
            add_face("u:" + str(x) + "," + str(y), [(x, y), (x + 1, y), (x, y + 1)])
            add_face("d:" + str(x) + "," + str(y), [(x + 1, y), (x + 1, y + 1), (x, y + 1)])
    return {
        "schemaVersion": 1,
        "coordinateSystem": "triangular-axial-v1",
        "topology": {
            "family": "planar",
            "movementStrategy": "simple-rays-v1",
            "territoryStrategy": "surface-discrete-v1",
            "specialVertexPolicy": "stop",
        },
        "vertices": vertices,
        "faces": faces,
        "seamPairs": [],
        "startingVertices": {"BLACK": _vertex_id(0, 0), "WHITE": _vertex_id(width, height)},
        "scoring": {"strategy": "canonical-vertices-v1"},
    }


def _minimal_triangle():
    """Fixed JS board-hash-v1 witness without an optional starts field."""

    return {
        "schemaVersion": 1,
        "coordinateSystem": "triangular-axial-v1",
        "topology": {"family": "planar"},
        "vertices": [
            {"id": _vertex_id(0, 0), "coordinate": [0, 0]},
            {"id": _vertex_id(1, 0), "coordinate": [1, 0]},
            {"id": _vertex_id(0, 1), "coordinate": [0, 1]},
        ],
        "faces": [{
            "id": "u:0,0",
            "vertices": [_vertex_id(0, 0), _vertex_id(1, 0), _vertex_id(0, 1)],
        }],
        "seamPairs": [],
        "scoring": {"strategy": "canonical-vertices-v1"},
    }


def _boundary_occurrences(definition):
    edges = {}
    for face in definition["faces"]:
        for side_index, left in enumerate(face["vertices"]):
            right = face["vertices"][(side_index + 1) % 3]
            key = tuple(sorted((left, right)))
            edges.setdefault(key, []).append({
                "id": face["id"] + ":" + str(side_index),
                "vertices": [left, right],
            })
    return [occurrences[0] for occurrences in edges.values() if len(occurrences) == 1]


def _disjoint_boundary_pair(definition):
    occurrences = _boundary_occurrences(definition)
    for index, first in enumerate(occurrences):
        for second in occurrences[index + 1:]:
            if not set(first["vertices"]) & set(second["vertices"]):
                return first, second
    raise AssertionError("fixture unexpectedly lacks disjoint boundary occurrences")


class BoardValidationTests(unittest.TestCase):
    def assert_error(self, result, code):
        self.assertFalse(result["ok"])
        self.assertIn(code, {error["code"] for error in result["errors"]})

    def test_valid_concave_facets_and_deterministic_hash(self):
        definition = _make_patch(width=5, height=3, excluded={(3, 0)})
        result = canonicalize_board_definition(definition)
        self.assertTrue(result["ok"], result.get("errors"))
        self.assertEqual(len(result["boardHash"]), 64)
        self.assertNotIn(_vertex_id(3, 0), {vertex["id"] for vertex in result["definition"]["vertices"]})
        reordered = deepcopy(definition)
        reordered["vertices"].reverse()
        reordered["faces"].reverse()
        reordered["display"] = {"camera": {"zoom": 2}, "cut": "not-gameplay"}
        reordered_result = canonicalize_board_definition(reordered)
        self.assertTrue(reordered_result["ok"], reordered_result.get("errors"))
        self.assertEqual(result["canonicalJson"], reordered_result["canonicalJson"])
        self.assertEqual(result["boardHash"], reordered_result["boardHash"])

    def test_accepts_arbitrary_disjoint_boundary_seam(self):
        definition = _make_patch()
        definition.pop("startingVertices")
        first, second = _disjoint_boundary_pair(definition)
        definition["seamPairs"] = [{
            "id": "pair:anywhere",
            "edgeOccurrenceA": first["id"],
            "edgeOccurrenceB": second["id"],
            "endpointMap": [1, 0],
        }]
        result = canonicalize_board_definition(definition)
        self.assertTrue(result["ok"], result.get("errors"))
        self.assertEqual(result["definition"]["seamPairs"][0]["endpointMap"], [1, 0])

    def test_rejects_self_duplicate_and_bad_endpoint_map(self):
        base = _make_patch()
        first, second = _disjoint_boundary_pair(base)
        self_seam = deepcopy(base)
        self_seam["seamPairs"] = [{
            "id": "self",
            "edgeOccurrenceA": first["id"],
            "edgeOccurrenceB": first["id"],
            "endpointMap": [0, 1],
        }]
        self.assert_error(validate_board_definition(self_seam), "SELF_SEAM")

        duplicate = deepcopy(base)
        third = next(
            occurrence for occurrence in _boundary_occurrences(duplicate)
            if occurrence["id"] not in {first["id"], second["id"]}
        )
        duplicate["seamPairs"] = [
            {
                "id": "first",
                "edgeOccurrenceA": first["id"],
                "edgeOccurrenceB": second["id"],
                "endpointMap": [0, 1],
            },
            {
                "id": "second",
                "edgeOccurrenceA": first["id"],
                "edgeOccurrenceB": third["id"],
                "endpointMap": [1, 0],
            },
        ]
        self.assert_error(validate_board_definition(duplicate), "DUPLICATE_SEAM_OCCURRENCE")

        bad_map = deepcopy(base)
        bad_map["seamPairs"] = [{
            "id": "bad-map",
            "edgeOccurrenceA": first["id"],
            "edgeOccurrenceB": second["id"],
            "endpointMap": [0, 0],
        }]
        self.assert_error(validate_board_definition(bad_map), "INVALID_ENDPOINT_MAP")

    def test_rejects_unknown_occurrence_and_merged_starts(self):
        unknown = _make_patch()
        unknown["seamPairs"] = [{
            "id": "unknown",
            "edgeOccurrenceA": "not:a:real:occurrence",
            "edgeOccurrenceB": "not:another:real:occurrence",
            "endpointMap": [0, 1],
        }]
        self.assert_error(validate_board_definition(unknown), "UNKNOWN_EDGE_OCCURRENCE")

        merged_starts = _make_patch()
        first, second = _disjoint_boundary_pair(merged_starts)
        merged_starts["startingVertices"] = {
            "BLACK": first["vertices"][0],
            "WHITE": second["vertices"][0],
        }
        merged_starts["seamPairs"] = [{
            "id": "merge-starts",
            "edgeOccurrenceA": first["id"],
            "edgeOccurrenceB": second["id"],
            "endpointMap": [0, 1],
        }]
        # Raw validation mirrors BoardDefinition.js.  Starts that become equal
        # only after seam quotienting are rejected by the compiled game board,
        # not silently rewritten at the transport boundary.
        self.assertTrue(validate_board_definition(merged_starts)["ok"])

    def test_resource_limit_and_non_mutation(self):
        definition = _make_patch()
        before = deepcopy(definition)
        result = validate_board_definition(definition, {"maxVertices": 2})
        self.assert_error(result, "LIMIT_EXCEEDED")
        self.assertEqual(definition, before)
        byte_limited = validate_board_definition(definition, {"maxBytes": 8})
        self.assert_error(byte_limited, "LIMIT_EXCEEDED")

    def test_board_hash_v1_matches_js_and_ignores_display_only_data(self):
        definition = _minimal_triangle()
        result = canonicalize_board_definition(definition)
        self.assertTrue(result["ok"], result.get("errors"))
        self.assertEqual(
            result["boardHash"],
            "942eb7c562e15612ef71083286578f482252133275230dc15428cc90e436f0cc",
        )
        self.assertNotIn("startingVertices", result["definition"])

        display_only = deepcopy(definition)
        display_only["display"] = {"camera": {"zoom": 2}, "cut": "presentation-only"}
        self.assertEqual(
            canonicalize_board_definition(display_only)["boardHash"],
            result["boardHash"],
        )

        generated = deepcopy(definition)
        generated["generator"] = {"version": "random-boundary-v1", "seed": 17, "values": {"z": 1, "a": 2}}
        generated_hash = canonicalize_board_definition(generated)["boardHash"]
        self.assertNotEqual(generated_hash, result["boardHash"])
        self.assertEqual(generated_hash, canonicalize_board_definition(deepcopy(generated))["boardHash"])

    def test_cross_language_hash_protocol_rejects_unicode_sort_keys(self):
        """Do not freeze a server hash whose browser ordering can differ.

        JavaScript's locale-aware identifier ordering previously placed
        ``v:\u00e4`` differently from Python's code-point sort.  IDs and nested
        generator object keys are protocol tokens, so the shared validator now
        rejects them before either runtime can derive an incompatible hash.
        """

        unicode_vertex = _minimal_triangle()
        unicode_vertex["vertices"][0]["id"] = "v:\u00e4"
        unicode_vertex["faces"][0]["vertices"][0] = "v:\u00e4"
        self.assert_error(canonicalize_board_definition(unicode_vertex), "INVALID_VERTEX_ID")

        unicode_generator_key = _minimal_triangle()
        unicode_generator_key["generator"] = {"\u00e4": {"seed": 17}}
        self.assert_error(canonicalize_board_definition(unicode_generator_key), "INVALID_GENERATOR_KEY")

    def test_topology_wire_vertex_ids_are_the_exact_canonical_set(self):
        """The relay accepts only compiler-issued IDs, never source aliases."""

        definition = _minimal_triangle()
        self.assertEqual(
            topology_canonical_vertex_ids(definition),
            frozenset({"cv:0", "cv:1", "cv:2"}),
        )
        accepted = topology_canonical_vertex_ids(definition)
        self.assertNotIn("v:0,0", accepted)
        self.assertNotIn("cv:01", accepted)
        self.assertNotIn("cv:-1", accepted)
        self.assertNotIn("cv:3", accepted)

    def test_topology_room_settings_are_server_canonical_and_hash_bound(self):
        definition = _make_patch()
        submitted = {
            "rulesVersion": SURFACE_RULES_VERSION,
            "boardShape": TOPOLOGY_BOARD_SHAPE,
            "boardDefinition": definition,
            # This is display-only and must not leak into the fixed room map.
            "boardHash": canonicalize_board_definition(definition)["boardHash"],
        }
        before = deepcopy(submitted)
        result = canonicalize_topology_room_settings(submitted, ["BLACK", "WHITE"])
        self.assertTrue(result["ok"], result.get("errors"))
        self.assertEqual(submitted, before)
        self.assertEqual(result["settings"]["rulesVersion"], SURFACE_RULES_VERSION)
        self.assertEqual(result["settings"]["boardShape"], TOPOLOGY_BOARD_SHAPE)
        self.assertEqual(result["settings"]["topologyProtocolVersion"], TOPOLOGY_ROOM_PROTOCOL_VERSION)
        self.assertEqual(result["settings"]["boardHash"], canonicalize_board_definition(definition)["boardHash"])
        self.assertEqual(result["settings"]["boardDefinition"], canonicalize_board_definition(definition)["definition"])

        mismatched_hash = deepcopy(submitted)
        mismatched_hash["boardHash"] = "0" * 64
        self.assert_error(
            canonicalize_topology_room_settings(mismatched_hash, ["BLACK", "WHITE"]),
            "BOARD_HASH_MISMATCH",
        )

    def test_topology_room_settings_fail_closed_for_partial_or_wrong_starts(self):
        definition = _make_patch()
        baseline = {
            "rulesVersion": SURFACE_RULES_VERSION,
            "boardShape": TOPOLOGY_BOARD_SHAPE,
            "boardDefinition": definition,
        }
        self.assertTrue(topology_settings_requested(baseline))
        self.assertTrue(topology_settings_requested({"boardDefinition": definition}))
        self.assertTrue(topology_settings_requested({"boardShape": TOPOLOGY_BOARD_SHAPE}))
        self.assertFalse(topology_settings_requested({"boardShape": "triangle"}))

        missing_definition = {
            "rulesVersion": SURFACE_RULES_VERSION,
            "boardShape": TOPOLOGY_BOARD_SHAPE,
        }
        self.assert_error(
            canonicalize_topology_room_settings(missing_definition, ["BLACK", "WHITE"]),
            "MISSING_BOARD_DEFINITION",
        )

        wrong_shape = deepcopy(baseline)
        wrong_shape["boardShape"] = "triangle"
        self.assert_error(
            canonicalize_topology_room_settings(wrong_shape, ["BLACK", "WHITE"]),
            "INVALID_TOPOLOGY_BOARD_SHAPE",
        )

        wrong_players = deepcopy(baseline)
        self.assert_error(
            canonicalize_topology_room_settings(wrong_players, ["BLACK", "WHITE", "PURPLE"]),
            "STARTING_PLAYERS_MISMATCH",
        )

        missing_starts = deepcopy(baseline)
        missing_starts["boardDefinition"].pop("startingVertices")
        self.assert_error(
            canonicalize_topology_room_settings(missing_starts, ["BLACK", "WHITE"]),
            "MISSING_STARTING_VERTICES",
        )

        bot_room = deepcopy(baseline)
        bot_room["botCount"] = 1
        self.assert_error(
            canonicalize_topology_room_settings(bot_room, ["BLACK", "WHITE"]),
            "TOPOLOGY_BOTS_UNSUPPORTED",
        )

    def test_topology_room_settings_reject_start_vertices_merged_by_a_seam(self):
        definition = _make_patch()
        black = definition["startingVertices"]["BLACK"]
        white = definition["startingVertices"]["WHITE"]
        occurrences = _boundary_occurrences(definition)
        first = next(occurrence for occurrence in occurrences if black in occurrence["vertices"])
        second = next(occurrence for occurrence in occurrences if white in occurrence["vertices"])
        self.assertNotEqual(first["id"], second["id"])
        first_index = first["vertices"].index(black)
        second_index = second["vertices"].index(white)
        definition["seamPairs"] = [{
            "id": "merge-room-starts",
            "edgeOccurrenceA": first["id"],
            "edgeOccurrenceB": second["id"],
            "endpointMap": [0, 1] if first_index == second_index else [1, 0],
        }]
        submitted = {
            "rulesVersion": SURFACE_RULES_VERSION,
            "boardShape": TOPOLOGY_BOARD_SHAPE,
            "boardDefinition": definition,
        }
        self.assert_error(
            canonicalize_topology_room_settings(submitted, ["BLACK", "WHITE"]),
            "MERGED_STARTING_VERTICES",
        )

    def test_topology_room_rejects_a_seam_that_collapses_quotient_edges(self):
        """The transport validator must reject maps that Web cannot compile.

        Both selected occurrences are individually valid, distinct boundary
        edges of the same triangle.  Their same-direction endpoint map merges
        all three triangle corners in the quotient.  It passes raw schema
        validation and leaves the two configured starts distinct, but the
        compiled topology has degenerate quotient edges and a non-manifold
        vertex link.  Accepting it would freeze an online room that every Web
        client then rejects during `compileBoard`.
        """

        definition = _make_patch(width=3, height=3)
        definition["seamPairs"] = [{
            "id": "collapse-first-triangle",
            "edgeOccurrenceA": "u:0,0:0",
            "edgeOccurrenceB": "u:0,0:2",
            "endpointMap": [0, 1],
        }]
        submitted = {
            "rulesVersion": SURFACE_RULES_VERSION,
            "boardShape": TOPOLOGY_BOARD_SHAPE,
            "boardDefinition": definition,
        }
        result = canonicalize_topology_room_settings(submitted, ["BLACK", "WHITE"])
        self.assert_error(result, "DEGENERATE_QUOTIENT_EDGE")


if __name__ == "__main__":
    unittest.main()
