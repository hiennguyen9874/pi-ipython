"""Contain the Kernel and all ordinary subprocesses before running any Cells.

The Kernel owns the job handle, so Windows kills its descendants on graceful
exit, forced termination, or an owner-watchdog exit. Never continue uncontained.
"""
import ctypes
from ctypes import wintypes
import runpy

from rlm import _winjob

job = _winjob.create_job()
if job is None:
    raise OSError("Cannot create the Python Kernel's kill-on-close Windows job")

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
assign = kernel32.AssignProcessToJobObject
assign.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
assign.restype = wintypes.BOOL
if not assign(job, wintypes.HANDLE(-1)):  # GetCurrentProcess pseudo-handle
    error = ctypes.get_last_error()
    _winjob.close(job)
    raise OSError(error, "Cannot contain the Python Kernel in its Windows job")

# Keep the non-inheritable handle open until process exit; descendants inherit
# job membership, not the handle that would otherwise keep them alive.
runpy.run_module("rlm.repl", run_name="__main__")
