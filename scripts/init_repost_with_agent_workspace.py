#!/usr/bin/env python3
"""Create a starter repost_with_agent workspace.

The workspace is user-owned runtime state, not repo state. It contains setup,
queue, state, and logs files that an agent can operate with a logged-in browser.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "templates" / "repost_with_agent_workspace"


def copy_template(target: Path, force: bool) -> None:
    if not TEMPLATE.exists():
        raise SystemExit(f"Template directory not found: {TEMPLATE}")

    target.mkdir(parents=True, exist_ok=True)
    for source in TEMPLATE.rglob("*"):
        relative = source.relative_to(TEMPLATE)
        destination = target / relative
        if source.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
            continue
        if destination.exists() and not force:
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create a repost_with_agent workspace with setup, queue, state, and logs files."
    )
    parser.add_argument("directory", help="Workspace directory to create")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing template files in the target directory",
    )
    args = parser.parse_args()

    target = Path(args.directory).expanduser().resolve()
    copy_template(target, args.force)

    print(f"Created repost_with_agent workspace at {target}")
    print("Next: edit user-setup.json and add one JSON object per item to queue.jsonl.")
    print("Default publish_mode is manual; stop before public posting unless explicitly approved.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
