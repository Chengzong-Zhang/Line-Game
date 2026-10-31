# LIFELINE Windows — third-party notices

The game bundles Electron and its Chromium runtime, Vue and MathJax, with their
runtime dependencies. Their license terms remain in force independently of the
game's distribution terms. `DEPENDENCY_LICENSES.txt` contains the license and
notice files from the pinned production npm packages. `LICENSE.electron.txt`
and `LICENSES.chromium.html` are beside `LIFELINE.exe`. Additional original
Vue and MathJax license files are retained inside `resources/app.asar`.

No custom font files or recorded sound library are added by this desktop build.
The interface uses installed system fonts; action sounds are synthesized by the
application. The new geometric application mark and capsule layout are generated
from project source in `desktop/scripts/prepare-branding.cjs`.

Game contributors are credited in the in-game guide. Those credits acknowledge
contributions; they do not by themselves grant redistribution rights for project
code, guide images or inference models. The local release preparation inventory
records that distinction. This notice does not assign a new open-source license
to LIFELINE or assert ownership of third-party work.

This local candidate does not bundle the Steamworks SDK. Steam and Steamworks
are trademarks of Valve Corporation. The local game does not currently provide
verified Steam achievements, Cloud or Overlay integration.
