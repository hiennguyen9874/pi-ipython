# pi-ipython

A pi extension that gives the model a persistent Python REPL as its primary tool, modelled on Unharnessed.

## Language

**Kernel**:
The long-lived Python process owned by one pi session, in which all Cells run against one shared namespace.
_Avoid_: Jupyter kernel, ipykernel, interpreter

**Kernel runtime**:
The Python package running inside the Kernel that speaks the host protocol (vendored from Unharnessed's `rlm`).
_Avoid_: rlm, shim

**Cell**:
One unit of Python code the model submits to the Kernel in a single `ipython` tool call.
_Avoid_: Script, snippet, execution

**Background command**:
A `bash()` command still running after the Cell that started it has ended.
_Avoid_: detached bash, background job, async bash

**Background output**:
Output with no owning Cell (threads, subprocesses, tasks of finished Cells), reported with the next Cell.
_Avoid_: unattributed output, orphan output

**Spill file**:
The file holding a Cell's full output when its result shows only the tail.
_Avoid_: temp file, full output file, log

**Kernel replacement**:
The Kernel process that ran earlier Cells is gone for any reason (crash, protocol break, user kill, user restart, new session), so the next Cell runs in a different process.
_Avoid_: restart, reset, crash (as the umbrella term)

**Pi tool**:
A tool registered in the pi session other than `ipython`, which a Cell may call from Python.
_Avoid_: host tool, extension tool

**Bridged call**:
One call a Cell makes to a Pi tool, subject to pi's tool hooks and permission checks.
_Avoid_: nested call, host request, tool bridge call

**Python state**:
The user-defined names (variables, functions, imports) living in the Kernel's namespace between Cells.
_Avoid_: Kernel memory, variables, notebook state

**Python-state notice**:
The message telling the model which Python state survived after a compaction.
_Avoid_: State summary, kernel report

**State-loss notice**:
The message warning the model that earlier Python state is unavailable and that external effects may still exist.
_Avoid_: Restart notice, kernel reset
