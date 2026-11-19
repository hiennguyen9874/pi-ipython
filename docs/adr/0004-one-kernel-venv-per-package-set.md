# One Kernel venv per Kernel package set

The uv-managed Kernel venv lives in a directory keyed by Python version and a hash of the Kernel package list, instead of one shared venv per Python version. Every pi process shares the venv directory, and a venv whose identity has changed gets deleted and rebuilt. If the package list were part of a shared venv's identity, two projects with different lists would keep rebuilding each other's venv, and could delete it while the other project's Kernel was running.

## Considered Options

- **One shared venv per Python version** (the old layout): uses the least disk, but different package lists thrash it and break live Kernels.
- **One venv per project (cwd)**: isolated, but projects with the same list duplicate the venv, and the venv would follow the directory, not the content.

## Consequences

- Each distinct package list costs its own venv on disk (about 150 MB with the defaults). Editing the list leaves the old venv behind; cleaning these up is a separate concern.
- Packages the model installs during a session go into the current set's venv and last until that venv is rebuilt (a runtime upgrade). They are never recorded.
