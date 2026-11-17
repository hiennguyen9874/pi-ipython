"""``pi`` in every Kernel: Bridged calls from a Cell to the session's Pi tools.

Owned by pi-ipython, not part of the vendored Kernel runtime; the Kernel bootstrap
loads this file and binds it as ``pi``. Async only: a synchronous wrapper would block
the event loop the Cell runs on, so the host's reply could never be received.
"""

from __future__ import annotations

from typing import Any

from rlm import repl as _repl

__all__ = ["ToolError", "describe", "describe_namespace", "search", "tool", "tools"]


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


async def search(query: str, limit: int = 8) -> list[dict[str, Any]]:
    """Rank the Pi tools a Cell can call against ``query`` (BM25 over names, descriptions, schemas, and namespaces).

    Returns at most ``limit`` entries shaped like ``tools()``, best match first. Raises ToolError
    when search is turned off (``piTools.search: false``).
    """
    if not isinstance(query, str) or not query.strip():
        raise TypeError("query must be a non-empty str")
    if isinstance(limit, bool) or not isinstance(limit, int):
        raise TypeError(f"limit must be an int, got {type(limit).__name__}")
    if limit <= 0:
        raise ValueError("limit must be positive")
    return await _request({"type": "pi.search", "query": query, "limit": limit})


async def describe(name: str) -> dict[str, Any]:
    """Describe the Pi tool ``name``: ``{"name", "description", "namespace", "parameters", "guidelines", "returns"}``.

    ``description`` is the full text, ``parameters`` the arguments' JSON schema, ``guidelines``
    the tool's prompt guidelines (a list of str), and ``returns`` its output schema, or ``"str"``
    when it has none. Raises ToolError when ``name`` is not a tool a Cell can call.
    """
    if not isinstance(name, str) or not name:
        raise TypeError("name must be a non-empty str")
    return await _request({"type": "pi.describe", "name": name})


async def describe_namespace(name: str) -> dict[str, Any]:
    """Describe the namespace ``name`` of callable Pi tools, such as an MCP server.

    Returns ``{"name", "description", "instructions"}``; absent fields are None.
    Raises ToolError when no callable tool is in that namespace.
    """
    if not isinstance(name, str) or not name:
        raise TypeError("name must be a non-empty str")
    return await _request({"type": "pi.describe_namespace", "name": name})


async def _request(data: dict[str, Any]) -> Any:
    # Detached tasks retain their originating Cell context, even while another Cell runs.
    context = _repl.current_cell_completion_context()
    if context is None or context[0].is_set():
        raise ToolError("Bridged calls are only allowed while their originating Cell runs")
    reply = await _repl.host_request(data)
    if reply.get("status") == "ok":
        return reply.get("result")
    raise ToolError(str(reply.get("error") or f"{data['type']} failed"))
