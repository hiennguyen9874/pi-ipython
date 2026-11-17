"""``pi`` in every Kernel: Bridged calls from a Cell to the session's Pi tools.

Owned by pi-ipython, not part of the vendored Kernel runtime; the Kernel bootstrap
loads this file and binds it as ``pi``. Async only: a synchronous wrapper would block
the event loop the Cell runs on, so the host's reply could never be received.
"""

from __future__ import annotations

from typing import Any

from rlm import repl as _repl

__all__ = ["ToolError", "describe", "tool", "tools"]


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
    return await _request({"type": "pi.tool", "name": name, "args": args or {}})


async def tools() -> list[dict[str, Any]]:
    """List the Pi tools a Cell can call, read live from the session.

    Each entry is ``{"name", "description", "namespace"}``: the first line of the
    description, and the namespace name or None.
    """
    return await _request({"type": "pi.tools"})


async def describe(name: str) -> dict[str, Any]:
    """Describe the Pi tool ``name``: ``{"name", "description", "namespace", "parameters"}``.

    ``description`` is the full text and ``parameters`` the arguments' JSON schema.
    Raises ToolError when ``name`` is not a tool a Cell can call.
    """
    if not isinstance(name, str) or not name:
        raise TypeError("name must be a non-empty str")
    return await _request({"type": "pi.describe", "name": name})


async def _request(data: dict[str, Any]) -> Any:
    # Detached tasks retain their originating Cell context, even while another Cell runs.
    context = _repl.current_cell_completion_context()
    if context is None or context[0].is_set():
        raise ToolError("Bridged calls are only allowed while their originating Cell runs")
    reply = await _repl.host_request(data)
    if reply.get("status") == "ok":
        return reply.get("result")
    raise ToolError(str(reply.get("error") or f"{data['type']} failed"))
