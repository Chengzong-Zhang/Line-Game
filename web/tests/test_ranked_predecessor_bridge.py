"""Predecessor dispatch is opt-in, hash-bound, and fails closed on drift."""
import hashlib
import json
import subprocess
from pathlib import Path
import pytest
from test_wechat_ladder import wx


def configure(monkeypatch, tmp_path):
    predecessor = tmp_path / 'ranked-predecessor-r6'
    tree = predecessor / 'service'
    validator = tree / 'wechat/minigame/tools/validate-action.mjs'
    validator.parent.mkdir(parents=True)
    validator.write_text('fixture validator', encoding='utf8')
    asset = tree / 'web/data/model.json'; asset.parent.mkdir(parents=True); asset.write_text('fixture model', encoding='utf8')
    hashes = {p.relative_to(tree).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in tree.rglob('*') if p.is_file()}
    raw = json.dumps({'releaseId':'wechat-service-all-20261029-r6', 'kind':'wechat-complete-runtime-release', 'candidate':hashes}).encode()
    (predecessor / 'release-manifest.json').write_bytes(raw)
    monkeypatch.setattr(wx, 'ROOT', tmp_path)
    monkeypatch.setattr(wx, 'RANKED_PREDECESSOR_R6_MANIFEST_SHA256', hashlib.sha256(raw).hexdigest())
    monkeypatch.setattr(wx, 'RANKED_PREDECESSOR_R6_FILES', len(hashes))
    return predecessor, validator, asset


def test_dispatch_is_fixed_and_unknown_fingerprint_stays_current(monkeypatch, tmp_path):
    predecessor, validator, _ = configure(monkeypatch, tmp_path)
    calls = []
    def run(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=b'{"currentPlayer":"BLACK"}', stderr=b'')
    monkeypatch.setattr(wx.subprocess, 'run', run)
    wx.verify_rules({}, [], ai_profile='greedy', ai_runtime=wx.RANKED_PREDECESSOR_R6_FINGERPRINT)
    assert Path(calls[-1][1]) == validator
    wx.verify_rules({}, [], ai_profile='greedy', ai_runtime='0' * 64)
    assert Path(calls[-1][1]) == wx.VALIDATOR
    wx.verify_rules({}, [], ranked_setup={'profile':'greedy'})
    assert Path(calls[-1][1]) == wx.VALIDATOR
    wx.verify_rules({}, [], {'type':'skip'}, ai_runtime=wx.RANKED_PREDECESSOR_R6_FINGERPRINT)
    assert Path(calls[-1][1]) == validator


def test_absent_snapshot_preserves_existing_guard_and_tamper_fails_closed(monkeypatch, tmp_path):
    monkeypatch.setattr(wx, 'ROOT', tmp_path)
    assert wx.ranked_predecessor_validator(wx.RANKED_PREDECESSOR_R6_FINGERPRINT) is None
    predecessor, validator, asset = configure(monkeypatch, tmp_path)
    assert wx.ranked_predecessor_validator(wx.RANKED_PREDECESSOR_R6_FINGERPRINT) == validator
    asset.write_text('tampered model', encoding='utf8')
    with pytest.raises(wx.HTTPException) as exc:
        wx.ranked_predecessor_validator(wx.RANKED_PREDECESSOR_R6_FINGERPRINT)
    assert exc.value.status_code == 409 and exc.value.detail == 'AI_VERSION_CHANGED'
    asset.write_text('fixture model', encoding='utf8')
    (predecessor / 'service' / 'extra').write_text('unexpected', encoding='utf8')
    with pytest.raises(wx.HTTPException) as exc:
        wx.ranked_predecessor_validator(wx.RANKED_PREDECESSOR_R6_FINGERPRINT)
    assert exc.value.detail == 'AI_VERSION_CHANGED'
