from __future__ import annotations

import ast
import math
import signal
from typing import Any

import numpy as np


class SandboxError(Exception):
    pass


class CellTimeout(Exception):
    pass


SAFE_BUILTINS: dict[str, Any] = {
    "abs": abs, "min": min, "max": max, "sum": sum, "len": len,
    "range": range, "enumerate": enumerate, "zip": zip, "map": map,
    "filter": filter, "sorted": sorted, "reversed": reversed, "round": round,
    "int": int, "float": float, "str": str, "bool": bool, "list": list,
    "dict": dict, "set": set, "tuple": tuple, "isinstance": isinstance,
    "all": all, "any": any, "pow": pow, "divmod": divmod, "print": print,
    "Exception": Exception, "ValueError": ValueError, "TypeError": TypeError,
}

FORBIDDEN_CALLS = {
    "open", "eval", "exec", "compile", "input", "globals", "locals", "vars",
    "getattr", "setattr", "delattr", "breakpoint", "exit", "quit", "help",
    "memoryview", "iter", "next", "hasattr",
}

FORBIDDEN_NODES = (
    ast.Import, ast.ImportFrom, ast.ClassDef, ast.AsyncFunctionDef,
    ast.With, ast.AsyncWith, ast.Global, ast.Nonlocal, ast.Delete,
    ast.Yield, ast.YieldFrom, ast.Await,
)

ALLOWED_MODULES = ("numpy", "math")


def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if root not in ALLOWED_MODULES:
        raise SandboxError(f"沙箱内禁止导入模块: {name}")
    return __import__(name, globals, locals, fromlist, level)


MAX_RESULT_ITEMS = 2000
CELL_TIMEOUT_SECONDS = 5


def validate_code(code: str) -> ast.Module:
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as exc:
        raise SandboxError(f"语法错误: {exc}") from exc
    for node in ast.walk(tree):
        if isinstance(node, FORBIDDEN_NODES):
            raise SandboxError(f"不允许的语法结构: {type(node).__name__}")
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise SandboxError(f"不允许访问内部名称: {node.id}")
        if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            raise SandboxError(f"不允许访问内部属性: {node.attr}")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id in FORBIDDEN_CALLS:
                raise SandboxError(f"沙箱内禁止调用: {node.func.id}")
    return tree


def extract_refs(tree: ast.Module) -> set[str]:
    """Find referenced cell names: inputs['name'] or inputs.name."""
    refs: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) \
                and node.value.id == "inputs":
            sl = node.slice
            if isinstance(sl, ast.Constant) and isinstance(sl.value, str):
                refs.add(sl.value)
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) \
                and node.value.id == "inputs":
            refs.add(node.attr)
    return refs


def _timeout_handler(signum, frame):
    raise CellTimeout(f"计算超时（超过 {CELL_TIMEOUT_SECONDS} 秒）")


def to_jsonable(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return str(value)
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        flat = value.ravel()
        if flat.size > MAX_RESULT_ITEMS:
            return {"__truncated__": True, "shape": list(value.shape),
                    "head": flat[:MAX_RESULT_ITEMS].tolist()}
        return value.tolist()
    if isinstance(value, dict):
        return {str(k): to_jsonable(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        items = list(value)[:MAX_RESULT_ITEMS]
        return [to_jsonable(v, depth + 1) for v in items]
    return str(value)


def run_cell(code: str, inputs: dict[str, Any], params: dict[str, Any]) -> Any:
    tree = validate_code(code)
    glb: dict[str, Any] = {"__builtins__": dict(SAFE_BUILTINS)}
    glb["__builtins__"]["__import__"] = _safe_import
    glb.update({
        "inputs": inputs,
        "params": params,
        "np": np,
        "math": math,
        "result": None,
    })
    compiled = compile(tree, "<cell>", "exec")
    old = signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(CELL_TIMEOUT_SECONDS)
    try:
        exec(compiled, glb)  # sandboxed by validation above
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old)
    return glb.get("result")
