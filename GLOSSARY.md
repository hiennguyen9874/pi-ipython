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

**Kernel replacement**:
The Kernel process that ran earlier Cells is gone for any reason (crash, protocol break, user kill, user restart, new session), so the next Cell runs in a different process.
_Avoid_: restart, reset, crash (as the umbrella term)

**Python state**:
The user-defined names (variables, functions, imports) living in the Kernel's namespace between Cells.
_Avoid_: Kernel memory, variables, notebook state

**Python-state notice**:
The message telling the model which Python state survived after a compaction.
_Avoid_: State summary, kernel report

**State-loss notice**:
The message telling the model its Kernel was replaced and all earlier Python state is gone.
_Avoid_: Restart notice, kernel reset
