"""``pi`` in every Kernel: Bridged calls from a Cell to the session's Pi tools, and Model calls.

Owned by pi-ipython, not part of the vendored Kernel runtime; the Kernel bootstrap
loads this file and binds it as ``pi``. Async only: a synchronous wrapper would block
the event loop the Cell runs on, so the host's reply could never be received.
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
from typing import Any

from rlm import repl as _repl

__all__ = ["ModelCallError", "ToolError", "ask", "classify", "describe", "describe_namespace", "search", "tool", "tools"]


class ToolError(RuntimeError):
    """A Bridged call failed: unknown or excluded tool, invalid arguments, a blocking hook, or the tool's own error.

    ``result`` is the failed tool's structured result (a dict) when it declares an output
    schema and its error result carries one, otherwise None.
    """

    def __init__(self, message: str, result: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.result = result


class ModelCallError(RuntimeError):
    """A Model call failed: turned off, classifier unset, model or classifier not found or without credentials,
    per-Cell limit reached, provider error, aborted, or called after its Cell ended. Carries the provider's error text when there is one.
    """


async def ask(prompt: str, *, system: str | None = None) -> str:
    """Ask a model with no tools and no Kernel of its own (a Model call); returns its answer text.

    ``system`` is an optional system prompt. Each call is one request without history. The host runs at
    most 8 Model calls of a Cell at once and queues the rest, up to the per-Cell budget.
    Raises ModelCallError when the call fails, including an answer cut off at its output limit.
    """
    if not isinstance(prompt, str) or not prompt:
        raise TypeError("prompt must be a non-empty str")
    if system is not None and not isinstance(system, str):
        raise TypeError(f"system must be a str or None, got {type(system).__name__}")
    return await _model_call({"type": "pi.ask", "prompt": prompt, "system": system})


async def classify(
    state: dict[str, Any], questions: dict[str, Any], *, images: list | None = None
) -> dict[str, Any]:
    """Ask the configured classifier typed questions about ``state`` (a Model call); returns the answers by question ID.

    ``questions`` maps question IDs to pi's classifier questions (``bool``, ``choice``, or ``score``); the
    answers are pi's classifier answers, unchanged. Shares the 8-in-flight cap and the per-Cell limit with
    ``ask``. ``images`` accepts paths (relative to the Kernel cwd), bytes-like values, and Pillow
    images (encoded as PNG). PNG, JPEG, WebP, and GIF are detected by the host.
    Raises ModelCallError when the call fails.
    """
    if not isinstance(state, dict):
        raise TypeError(f"state must be a dict, got {type(state).__name__}")
    try:
        json.dumps(state, allow_nan=False)
    except (TypeError, ValueError) as e:
        raise type(e)(f"state must be JSON-serializable: {e}") from None
    if not isinstance(questions, dict):
        raise TypeError(f"questions must be a dict, got {type(questions).__name__}")
    if not questions:
        raise ValueError("questions must not be empty")
    encoded_images = []
    if images is not None:
        if not isinstance(images, list):
            raise TypeError("images must be a list or None")
        pillow_image_type = getattr(sys.modules.get("PIL.Image"), "Image", ())
        for image in images:
            if isinstance(image, (str, os.PathLike)):
                path = os.fsdecode(os.fspath(image))
                if os.name == "nt":
                    path = os.path.abspath(path)
                elif not os.path.isabs(path):
                    # Leave ".." for the filesystem to resolve after following symlinks.
                    path = os.path.join(os.getcwd(), path)
                encoded_images.append({"path": path})
            elif isinstance(image, (bytes, bytearray, memoryview)):
                data = image.tobytes() if isinstance(image, memoryview) else image
                encoded_images.append({"data": base64.b64encode(data).decode("ascii")})
            elif isinstance(image, pillow_image_type):
                encoded_images.append({"data": _pillow_png(image)})
            else:
                raise TypeError(f"images items must be paths, bytes, or PIL.Image, got {type(image).__name__}")
    try:
        return await _model_call({
            "type": "pi.classify", "state": state, "questions": questions, "images": encoded_images
        })
    except (TypeError, ValueError) as e:
        raise ModelCallError(str(e)) from None


def _pillow_png(image: Any) -> str:
    if image.mode not in {"1", "L", "LA", "P", "RGB", "RGBA", "I;16", "I;16B"}:
        # Pillow needs to unpremultiply grayscale alpha before converting to RGBA.
        if image.mode == "La":
            image = image.convert("LA")
        image = image.convert("RGBA" if {"A", "a"}.intersection(image.getbands()) else "RGB")
    with io.BytesIO() as buffer:
        image.save(buffer, format="PNG")
        return base64.b64encode(buffer.getbuffer()).decode("ascii")


async def _model_call(data: dict[str, Any]) -> Any:
    reply = await _send(data, ModelCallError("Model calls are only allowed while their originating Cell runs"))
    if reply.get("status") == "ok":
        return reply.get("result")
    raise ModelCallError(str(reply.get("error") or "Model call failed"))


async def tool(name: str, args: dict[str, Any] | None = None) -> Any:
    """Call the Pi tool ``name`` with ``args``.

    Returns the tool's structured result (a dict) when it declares an output schema,
    otherwise its text content as one str. Raises ToolError when the call fails; its
    ``result`` holds a failed structured tool's result.
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


async def search(query: str, limit: int = 8, namespace: str | None = None) -> list[dict[str, Any]]:
    """Rank the Pi tools a Cell can call against ``query`` (BM25 over names, descriptions, schemas, and namespaces).

    With ``namespace`` (a name or alias, as in ``describe_namespace``), only that namespace's tools
    are ranked. Returns at most ``limit`` entries shaped like ``tools()``, best match first. Raises
    ToolError when search is turned off (``piTools.search: false``) or no callable tool is in ``namespace``.
    """
    if not isinstance(query, str) or not query.strip():
        raise TypeError("query must be a non-empty str")
    if isinstance(limit, bool) or not isinstance(limit, int):
        raise TypeError(f"limit must be an int, got {type(limit).__name__}")
    if limit <= 0:
        raise ValueError("limit must be positive")
    if namespace is not None and not isinstance(namespace, str):
        raise TypeError(f"namespace must be a non-empty str or None, got {type(namespace).__name__}")
    if namespace == "":
        raise TypeError("namespace must be a non-empty str or None")
    return await _request({"type": "pi.search", "query": query, "limit": limit, "namespace": namespace})


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
    reply = await _send(data, ToolError("Bridged calls are only allowed while their originating Cell runs"))
    if reply.get("status") == "ok":
        return reply.get("result")
    raise ToolError(str(reply.get("error") or f"{data['type']} failed"), reply.get("result"))


async def _send(data: dict[str, Any], ended: Exception) -> dict[str, Any]:
    """Send a host request for the running Cell; raise ``ended``, sending nothing, once that Cell has ended."""
    # Detached tasks retain their originating Cell context, even while another Cell runs.
    context = _repl.current_cell_completion_context()
    if context is None or context[0].is_set():
        raise ended
    return await _repl.host_request(data)
