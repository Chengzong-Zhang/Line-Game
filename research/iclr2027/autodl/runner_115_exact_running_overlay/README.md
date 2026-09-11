# AutoDL Runner 1.15 exact-running overlay

This process-local overlay exists only for candidate v19 and the already
running managed instance `pro-788096a9e3b2`.

Add this directory (not its parent) to the one `autodl-direct.exe` process's
`PYTHONPATH`. Python imports `sitecustomize.py` before the CLI and installs the
patch in memory. No file under `C:/Users/zcz/.local/AutoDLRunnerDirect` is
modified.

The overlay accepts only all of the following:

- Runner version `1.15.0`;
- `instance_reuse = "require"` and preferred UUID
  `pro-788096a9e3b2`;
- one platform record for that UUID, with a direct-runner managed name,
  `running`, `5090-p`, one GPU, and the requested region;
- the same name and complete compatible immutable profile in the exact
  registry row, whose state is `STOPPED` or `READY`;
- exact provider status `running` and snapshot price at most 2880
  milliyuan/hour;
- an atomic `allow_new=False` claim that advances exactly one generation.

Any missing or mismatched fact raises before Runner reaches generic warm
selection, incompatible-session cleanup, or provisioning. The overlay itself
has no create, power-on, power-off, reap, or release operation.

Local verification (no API access):

```powershell
& 'C:/Users/zcz/.local/AutoDLRunnerDirect/venv/Scripts/python.exe' -B `
  'research/iclr2027/autodl/runner_115_exact_running_overlay/tests/test_exact_running_adoption.py'
```
