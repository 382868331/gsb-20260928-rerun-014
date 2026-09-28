from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import engine, store
from .models import CellCreate, CellUpdate, Notebook, RunReport, RunRequest
from .seed import DEMO_ID, build_demo

app = FastAPI(title="科研计算笔记本")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_notebooks: dict[str, Notebook] = {}


def _get(nb_id: str) -> Notebook:
    nb = _notebooks.get(nb_id)
    if nb is None:
        raise HTTPException(404, "笔记本不存在")
    return nb


@app.on_event("startup")
def startup() -> None:
    for nb in store.list_all():
        _notebooks[nb.id] = nb
    if DEMO_ID not in _notebooks:
        nb = build_demo()
        _notebooks[nb.id] = nb
        store.save(nb)


@app.get("/api/notebooks")
def list_notebooks() -> list[dict]:
    return [{"id": n.id, "title": n.title, "cells": len(n.cells)}
            for n in _notebooks.values()]


@app.post("/api/notebooks", status_code=201)
def create_notebook(title: str = "未命名笔记本") -> Notebook:
    nb = Notebook(id=engine.new_id(), title=title)
    _notebooks[nb.id] = nb
    store.save(nb)
    return nb


@app.get("/api/notebooks/{nb_id}")
def get_notebook(nb_id: str) -> dict:
    nb = _get(nb_id)
    data = nb.model_dump()
    data["cycle"] = engine.notebook_cycle(nb)
    return data


@app.post("/api/notebooks/{nb_id}/cells", status_code=201)
def add_cell(nb_id: str, body: CellCreate) -> Notebook:
    nb = _get(nb_id)
    try:
        engine.add_cell(nb, body.name, body.kind, body.code, body.params)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    store.save(nb)
    return nb


@app.put("/api/notebooks/{nb_id}/cells/{cell_id}")
def update_cell(nb_id: str, cell_id: str, body: CellUpdate) -> Notebook:
    nb = _get(nb_id)
    try:
        engine.update_cell(nb, cell_id, name=body.name, code=body.code,
                           params=body.params)
    except KeyError:
        raise HTTPException(404, "单元不存在")
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    store.save(nb)
    return nb


@app.delete("/api/notebooks/{nb_id}/cells/{cell_id}")
def delete_cell(nb_id: str, cell_id: str) -> Notebook:
    nb = _get(nb_id)
    try:
        engine.delete_cell(nb, cell_id)
    except KeyError:
        raise HTTPException(404, "单元不存在")
    store.save(nb)
    return nb


@app.post("/api/notebooks/{nb_id}/run")
def run_notebook(nb_id: str, body: RunRequest) -> dict:
    nb = _get(nb_id)
    report: RunReport = engine.run_notebook(nb, force=body.force,
                                            only_ids=body.cell_ids)
    store.save(nb)
    data = nb.model_dump()
    data["cycle"] = engine.notebook_cycle(nb)
    return {"notebook": data, "report": report.model_dump()}


@app.post("/api/notebooks/{nb_id}/reset-demo")
def reset_demo(nb_id: str) -> Notebook:
    if nb_id != DEMO_ID:
        raise HTTPException(400, "只有演示笔记本可以重置")
    nb = build_demo()
    _notebooks[nb.id] = nb
    store.save(nb)
    return nb
