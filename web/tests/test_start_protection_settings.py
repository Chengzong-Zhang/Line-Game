"""Backend compatibility checks for the versioned start-protection rule."""

import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "web/web后端"
sys.path.insert(0, str(BACKEND))

import server

spec = importlib.util.spec_from_file_location("start_protection_wechat", BACKEND / "wechat_online.py")
wechat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wechat)


class StartProtectionSettingsTests(unittest.TestCase):
    def test_legacy_web_room_defaults_to_symmetric(self):
        manager = server.ConnectionManager()
        settings = manager._normalize_room_settings({
            "playerCount": 2,
            "boardShape": "triangle",
            "gridSize": 5,
        })
        self.assertEqual(settings["protectionRule"], server.START_PROTECTION_SYMMETRIC)

    def test_web_room_preserves_explicit_duel_rule(self):
        manager = server.ConnectionManager()
        settings = manager._normalize_room_settings({
            "playerCount": 2,
            "boardShape": "triangle",
            "gridSize": 5,
            "protectionRule": server.START_PROTECTION_DUEL_FIRST_UNPROTECTED,
        })
        self.assertEqual(settings["protectionRule"], server.START_PROTECTION_DUEL_FIRST_UNPROTECTED)

    def test_wechat_room_defaults_legacy_and_accepts_explicit_duel_rule(self):
        legacy = wechat.WechatService.room_settings({
            "playerCount": 2,
            "boardShape": "triangle",
            "gridSize": 5,
        })
        modern = wechat.WechatService.room_settings({
            "playerCount": 2,
            "boardShape": "triangle",
            "gridSize": 5,
            "protectionRule": wechat.PROTECTION_RULE_DUEL_FIRST_UNPROTECTED,
        })
        self.assertEqual(legacy["protectionRule"], wechat.PROTECTION_RULE_SYMMETRIC)
        self.assertEqual(modern["protectionRule"], wechat.PROTECTION_RULE_DUEL_FIRST_UNPROTECTED)

    def test_persisted_room_without_field_is_materialized_as_legacy(self):
        room = {
            "settings": {"playerCount": 2},
            "pendingSettings": {"playerCount": 2},
        }
        result = wechat.bind_legacy_protection_rule(room)
        self.assertIs(result, room)
        self.assertEqual(room["settings"]["protectionRule"], wechat.PROTECTION_RULE_SYMMETRIC)
        self.assertEqual(room["pendingSettings"]["protectionRule"], wechat.PROTECTION_RULE_SYMMETRIC)


if __name__ == "__main__":
    unittest.main()
