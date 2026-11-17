"""``pi`` in every Kernel: Bridged calls from a Cell to the session's Pi tools.

Owned by pi-ipython, not part of the vendored Kernel runtime; the Kernel bootstrap
loads this file and binds it as ``pi``. Async only: a synchronous wrapper would block
the event loop the Cell runs on, so the host's reply could never be received.
"""

from __future__ import annotations

from typing import Any

from rlm import repl as _repl

__all__ = ["ToolError", "tool"]


class ToolError(RuntimeError):
    """A Bridged call failed: unknown or excluded tool, invalid arguments, a blocking hook, or the tool's own error."""


async def tool(name: str, args: dict[str, Any] | None = None) -> Any:
    """Call the Pi tool ``name`` with ``args``.

    Returns the tool's structured result (a dict) when it declares an output schema,
    otherwise its text content as one str. Raises ToolError when the call fails.
    """
    if not isinstance(name, str) or not name:
        raise TypeError("name must be a non-empty str")
    if args is not None and not isinstance(args, dict):
        raise TypeError(f"args must be a dict or None, got {type(args).__name__}")
    # Detached tasks retain their originating Cell context, even while another Cell runs.
    context = _repl.current_cell_completion_context()
    if context is None or context[0].is_set():
        raise ToolError("Bridged calls are only allowed while their originating Cell runs")
    reply = await _repl.host_request({"type": "pi.tool", "name": name, "args": args or {}})
    if reply.get("status") == "ok":
        return reply.get("result")
    raise ToolError(str(reply.get("error") or f"Pi tool {name} failed"))
