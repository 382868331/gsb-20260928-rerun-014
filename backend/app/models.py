from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

CellKind = Literal["compute", "plot"]
CellStatus = Literal["fresh", "stale", "error"]


class Cell(BaseModel):
    id: str
    name: str
    kind: CellKind = "compute"
    code: str = ""
    params: dict[str, Any] = Field(default_factory=dict)
    deps: list[str] = Field(default_factory=list)
    status: CellStatus = "stale"
    version: int = 0
    input_versions: dict[str, int] = Field(default_factory=dict)
    result: Optional[Any] = None
    error: Optional[str] = None
    computed_at: Optional[float] = None


class Notebook(BaseModel):
    id: str
    title: str = "未命名笔记本"
    cells: list[Cell] = Field(default_factory=list)
    run_count: int = 0


class CellCreate(BaseModel):
    name: str
    kind: CellKind = "compute"
    code: str = ""
    params: dict[str, Any] = Field(default_factory=dict)


class CellUpdate(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    params: Optional[dict[str, Any]] = None


class RunRequest(BaseModel):
    force: bool = False
    cell_ids: Optional[list[str]] = None


class RunReport(BaseModel):
    ran: list[str] = Field(default_factory=list)
    failed: list[str] = Field(default_factory=list)
    skipped: list[str] = Field(default_factory=list)
    cycle: Optional[list[str]] = None
    errors: dict[str, str] = Field(default_factory=dict)
