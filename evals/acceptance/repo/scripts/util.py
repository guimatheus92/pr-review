"""Shared helpers for the reporting scripts."""

import subprocess


def run_query(sql: str) -> str:
    """Run a read-only query. Arguments are passed as a list, never a shell string."""
    result = subprocess.run(
        ["psql", "-tAc", sql], capture_output=True, text=True, check=True
    )
    return result.stdout
