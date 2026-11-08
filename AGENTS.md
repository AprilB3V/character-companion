# Character Companion

## Windows installation

For the public portable release, run
`cmd /d /c install.cmd --portable --non-interactive`.
This requires the published `v0.1.0-rc.2` release assets. It downloads the
Windows x64 package, verifies SHA-256 and the installed file manifest, then
creates local configuration. Git, Node.js and private submodule access are
unnecessary for the portable release. If the release is still a draft,
report that the public package is not available yet.

The commands below describe developer installation from source.

If the user requests installation, use a Git checkout of this repository and
run `cmd /d /c install.cmd --non-interactive` from its root. The installer
requires Git, Node.js 22.18 or later with npm, and existing read access to the
pinned private VideoCohost submodule. It installs locked dependencies without
prompting and preserves the user's configuration.

Treat exit code 0 and `INSTALL_OK` as dependency installation success. Exit 1
means installation failed. Exit 2 means invalid command arguments. Report a
missing prerequisite or denied submodule access as an installation failure.
Do not ask for model credentials in chat or inspect the contents of local
credential files. Without model configuration, the kernel uses a mock provider.

For an optional headless runtime check, run
`powershell -NoProfile -ExecutionPolicy Bypass -File pet/start.ps1 -Installed -NoWindow`.
Query `http://127.0.0.1:8790/api/status` and check `cl.connected`. Report game
connection separately. See [Windows installation](docs/install.md).
