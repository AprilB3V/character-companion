# Character Companion

## Windows installation

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
