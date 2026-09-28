from __future__ import annotations

import json
from pathlib import Path

from .models import Notebook

DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "notebooks"


def _path(nb_id: str) -> Path:
    safe = "".join(ch for ch in nb_id if ch.isalnum() or ch in "-_")
    return DATA_DIR / f"{safe}.json"


def save(nb: Notebook) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _path(nb.id).with_suffix(".tmp")
    tmp.write_text(nb.model_dump_json(indent=2), encoding="utf-8")
    tmp.replace(_path(nb.id))


def load(nb_id: str) -> Notebook | None:
    p = _path(nb_id)
    if not p.exists():
        return None
    return Notebook.model_validate(json.loads(p.read_text(encoding="utf-8")))


def list_all() -> list[Notebook]:
    if not DATA_DIR.exists():
        return []
    out = []
    for p in sorted(DATA_DIR.glob("*.json")):
        try:
            out.append(Notebook.model_validate(
                json.loads(p.read_text(encoding="utf-8"))))
        except Exception:
            continue
    return out


def delete(nb_id: str) -> None:
    p = _path(nb_id)
    if p.exists():
        p.unlink()
