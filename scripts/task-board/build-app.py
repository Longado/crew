"""Build a small native macOS window around the local task board."""
import argparse,json,pathlib,plistlib,shutil,subprocess,tempfile

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--workspace',required=True);p.add_argument('--manifest',required=True);p.add_argument('--output',required=True)
a=p.parse_args();repo=pathlib.Path(__file__).resolve().parents[2];out=pathlib.Path(a.output).expanduser()
if out.exists(): p.error('输出已存在，请选择新路径以保留已有应用。')
node=shutil.which('node');python=shutil.which('python3')
if not node or not python: p.error('需要已安装的Node和Python3。')
with tempfile.TemporaryDirectory(prefix='crew-tasks-build-') as tmp:
    bundle=pathlib.Path(tmp)/out.name;binary=bundle/'Contents/MacOS';resources=bundle/'Contents/Resources'
    binary.mkdir(parents=True);resources.mkdir()
    subprocess.run(['swiftc',str(repo/'scripts/task-board/macos/CrewTasks.swift'),'-o',str(binary/'CrewTasks'),'-framework','AppKit','-framework','WebKit'],check=True)
    config={'repo':str(repo),'workspace':str(pathlib.Path(a.workspace).resolve()),'manifest':str(pathlib.Path(a.manifest).resolve()),'node':node,'python':python}
    (resources/'config.json').write_text(json.dumps(config,ensure_ascii=False,indent=2))
    info={'CFBundleName':'Crew Tasks','CFBundleDisplayName':'Crew Tasks','CFBundleIdentifier':'local.crew.tasks','CFBundleExecutable':'CrewTasks','CFBundlePackageType':'APPL','CFBundleShortVersionString':'0.1.0','CFBundleIconFile':'icon','LSMinimumSystemVersion':'13.0','NSHighResolutionCapable':True,'NSAppTransportSecurity':{'NSAllowsLocalNetworking':True}}
    (bundle/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    iconset=pathlib.Path(tmp)/'icon.iconset';iconset.mkdir()
    subprocess.run([str(binary/'CrewTasks'),'--make-icon',str(iconset)],check=True)
    subprocess.run(['iconutil','-c','icns',str(iconset),'-o',str(resources/'icon.icns')],check=True)
    subprocess.run(['codesign','--force','--deep','--sign','-',str(bundle)],check=True)
    out.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(bundle,out)
print(out)
