"""pi-ipython test config for the vendored runtime suite (not vendored itself).

Upstream HEAD made orphan-journal writes best-effort in bash._record_journal,
but these tests still expect a hard failure; they fail upstream too. Strict
xfail flags them without editing vendored files and alerts us when they pass.
"""

import pytest

_UPSTREAM_STALE = {
    "test_bash.py::BashTest::test_journal_configured_but_unwritable_kills_child_and_raises",
    "test_bash.py::BashTest::test_journal_short_write_rejects_when_configured",
    "test_bash.py::BashTest::test_missing_start_id_rejects_when_configured",
}


def pytest_collection_modifyitems(items):
    for item in items:
        if item.nodeid.removeprefix("test/") in _UPSTREAM_STALE:
            item.add_marker(pytest.mark.xfail(reason="stale upstream test: journaling is best-effort", strict=True))
