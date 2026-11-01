"""Check the app's two required-reason API declarations and target wiring."""
import plistlib, sys
from pathlib import Path
root=Path(sys.argv[1]) if len(sys.argv)>1 else Path('working/ios/native-v1')
info=plistlib.loads((root/'App/App/PrivacyInfo.xcprivacy').read_bytes())
assert set(info)=={'NSPrivacyAccessedAPITypes'}
items=info['NSPrivacyAccessedAPITypes']
assert len(items)==2
actual={item['NSPrivacyAccessedAPIType']:item['NSPrivacyAccessedAPITypeReasons'] for item in items}
assert actual=={'NSPrivacyAccessedAPICategorySystemBootTime':['35F9.1'], 'NSPrivacyAccessedAPICategoryFileTimestamp':['C617.1']}
pbx=(root/'App/App.xcodeproj/project.pbxproj').read_text(encoding='utf-8')
assert pbx.count('PrivacyInfo.xcprivacy in Resources')==2
assert pbx.count('A10000000000000000000006')==3
print('iOS required-reason manifest: PASS (declaration and static wiring only; full privacy review pending)')
