"""The staging entry point must never invoke an activation or stop command."""
import contextlib, importlib.util, io, json, sys, tempfile
from pathlib import Path
from unittest.mock import patch
import hashlib

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('wechat_preflight_stage',ROOT/'wechat/tools/stage_schema6_preflight.py')
stage=importlib.util.module_from_spec(spec);spec.loader.exec_module(stage)


def test_stage_invokes_only_preflight_and_hashes_all_inputs():
    with tempfile.TemporaryDirectory() as temp:
        root=Path(temp);bundle=root/'bundle';service=bundle/'service';service.mkdir(parents=True)
        (service/'source.js').write_text('ok')
        digest=lambda name:hashlib.sha256(name.read_bytes()).hexdigest()
        for name in ('probe.py','rollback-probe.py','rehearsal.py'):(bundle/name).write_text(name)
        manifest={'releaseId':'wechat-service-all-20261029-r9','candidate':{'source.js':digest(service/'source.js')},
                  'probeSha256':digest(bundle/'probe.py'),'rollbackProbeSha256':digest(bundle/'rollback-probe.py'),
                  'rehearsalSha256':digest(bundle/'rehearsal.py')}
        (bundle/'release-manifest.json').write_text(json.dumps(manifest),encoding='utf-8')
        tools=root/'wechat/tools';tools.mkdir(parents=True)
        for name in ('activate_profile_service_live.py','activate_service_schema6_release.py'):(tools/name).write_text(name)
        observed=[]
        def fake_call(command,**_):
            observed.append(command)
            return json.dumps({'status':'PREFLIGHT_PASSED_NO_LIVE_CHANGE','databaseRestored':False,'runtimeFiles':1}).encode() if 'sudo' in command else b''
        arguments=['stage','--bundle',str(bundle),'--transport',str(root/'transport.zip')]
        with patch.object(stage,'ROOT',root),patch.object(stage,'call',fake_call),patch.object(sys,'argv',arguments),contextlib.redirect_stdout(io.StringIO()) as output:
            stage.main()
        result=json.loads(output.getvalue());assert result['status']=='PREFLIGHT_PASSED_NO_LIVE_CHANGE'
        assert len(observed)==4 and observed[-1].count('preflight')==1
        assert all('activate' not in command and 'systemctl' not in command for command in observed)
        assert len(result['operatorHashes'])==2
