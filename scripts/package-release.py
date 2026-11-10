#!/usr/bin/env python3
"""仅打包可部署程序，不包含数据、会话、node_modules 和本机测试文件。"""
import argparse, tarfile
from pathlib import Path
root=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser();parser.add_argument('--output',default=str(root.parent/'releases'/'jiecheng-plm-1.9.9.tar.gz'));args=parser.parse_args()
if not (root/'dist/index.html').is_file():raise SystemExit('请先执行 npm run build')
out=Path(args.output).resolve();out.parent.mkdir(parents=True,exist_ok=True)
with tarfile.open(out,'w:gz') as archive:
    for name in ['dist','server','deploy','scripts/admin.py','scripts/import-feishu-shipping.py','start.sh','README.md']:
        source=root/name
        for file in ([source] if source.is_file() else sorted(source.rglob('*'))):
            if file.is_file() and '__pycache__' not in file.parts and file.suffix!='.pyc':archive.add(file,arcname='jiecheng-plm/'+str(file.relative_to(root)))
print(out)
