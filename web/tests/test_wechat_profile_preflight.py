"""Schema3/Pillow activation checks use only synthetic in-memory images and DBs."""
import builtins
from contextlib import closing
import importlib.util
import json
import sqlite3
import pytest

from test_wechat_service_preflight import check, codes, environment, snapshot, no_node_probe


@pytest.mark.parametrize("schema_version", [3, 4, 5, 6])
def test_profile_preflight_does_not_downgrade_or_mutate_profiles(tmp_path, no_node_probe, schema_version):
    spec = importlib.util.spec_from_file_location("profile_preflight_backend", check.ROOT / "web/web后端/wechat_online.py")
    wx = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wx)
    database = tmp_path / "shared.sqlite3"
    store = wx.WechatStore(database)
    uid = store.identity("a" * 64)
    with closing(sqlite3.connect(database)) as db:
        if schema_version < 6:
            for table in (wx.ladder.TABLES if schema_version == 3 else wx.ladder.CURRENT_TABLES if schema_version == 4 else wx.ladder.EXTRA_TABLES):
                db.execute(f"DROP TABLE {table}")
            db.execute(f"PRAGMA user_version={schema_version}")
        db.execute("INSERT INTO wx_profiles(uid,display_name,updated) VALUES(?,?,?)", (uid, "测试昵称", 1))
        db.commit()
    before = snapshot(tmp_path)
    result = check.check_service_config(environment(database))
    assert result["status"] == "PASS_LOCAL_CONFIGURATION_NOT_DEPLOYED"
    assert result["checks"]["database"] == f"VALID_V{schema_version}_READ_ONLY"
    assert result["checks"]["profileImages"] == "PASS_PILLOW_PNG_JPEG_SYNTHETIC_PROBE"
    assert snapshot(tmp_path) == before


def test_missing_pillow_blocks_activation_without_exposing_import_error(tmp_path, no_node_probe, monkeypatch):
    original = builtins.__import__

    def missing(name, *args, **kwargs):
        if name == "PIL":
            raise ImportError("private-local-dependency-path")
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", missing)
    result = check.check_service_config(environment(tmp_path / "new.sqlite3"))
    assert result["status"] == "BLOCKED_INVALID_CONFIGURATION"
    assert "PILLOW_UNAVAILABLE" in codes(result)
    assert "private-local" not in json.dumps(result)
    assert snapshot(tmp_path) == {}


def test_broken_jpeg_codec_blocks_even_when_pillow_imports(tmp_path, no_node_probe, monkeypatch):
    from PIL import Image
    original = Image.Image.save

    def broken(self, fp, format=None, **kwargs):
        if format == "JPEG":
            raise OSError("private-codec-detail")
        return original(self, fp, format=format, **kwargs)

    monkeypatch.setattr(Image.Image, "save", broken)
    result = check.check_service_config(environment(tmp_path / "new.sqlite3"))
    assert result["status"] == "BLOCKED_INVALID_CONFIGURATION"
    assert "PROFILE_IMAGE_CODEC_UNAVAILABLE" in codes(result)
    assert "private-codec-detail" not in json.dumps(result)
    assert snapshot(tmp_path) == {}
