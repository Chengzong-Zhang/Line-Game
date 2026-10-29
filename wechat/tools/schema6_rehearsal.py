"""Open a consistent private copy with both service revisions; never alter source."""
import argparse
from contextlib import closing
import importlib.util
import json
import sqlite3
import tempfile
from pathlib import Path


def schema(path):
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
        db.execute('PRAGMA query_only=ON')
        return {'version':db.execute('PRAGMA user_version').fetchone()[0],
                'ok':db.execute('PRAGMA quick_check').fetchall()==[('ok',)]}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for option in ('source','candidate','rollback','workdir'):
        parser.add_argument('--'+option, type=Path, required=True)
    args=parser.parse_args()
    source=args.source.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='schema6-rehearsal-',dir=args.workdir) as raw:
        copy=Path(raw)/'isolated.sqlite3'
        with closing(sqlite3.connect(source.as_uri()+'?mode=ro', uri=True)) as original, closing(sqlite3.connect(copy)) as target:
            original.backup(target)
        if schema(copy) != {'version':6,'ok':True}: raise RuntimeError('SOURCE_SCHEMA_UNEXPECTED')
        for index, tree in enumerate((args.candidate,args.rollback)):
            module_path=tree.resolve(strict=True)/'web/web后端/wechat_online.py'
            spec=importlib.util.spec_from_file_location('isolated_wx_'+str(index),module_path)
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            module.WechatStore(copy)
            if schema(copy) != {'version':6,'ok':True}: raise RuntimeError('REOPEN_SCHEMA_UNEXPECTED')
    print(json.dumps({'status':'PASS_SCHEMA6_COPY_BOTH_REVISIONS','schema':6}))


if __name__=='__main__': main()
