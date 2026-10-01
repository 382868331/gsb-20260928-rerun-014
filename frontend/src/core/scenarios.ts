import { runGraph, unitRevision } from "./engine";
import type { ComputeUnit, Experiment, Scenario, UnitResult } from "./types";

export const BASELINE_SCENARIO_ID = "baseline";

export function normalizeExperiment(exp: Experiment): Experiment {
  if (exp.scenarios && exp.scenarioOrder && exp.scenarioResults) return exp;
  const now = exp.updatedAt || Date.now();
  const baseline: Scenario = {
    id: BASELINE_SCENARIO_ID,
    name: "基线参数",
    parentScenarioId: null,
    createdAt: exp.createdAt || now,
    updatedAt: now,
    parameterValues: {},
    formulaOverrides: {},
    pendingFormulaRevision: null,
  };
  return {
    ...exp,
    scenarios: { [baseline.id]: baseline },
    scenarioOrder: [baseline.id],
    activeScenarioId: BASELINE_SCENARIO_ID,
    scenarioResults: { [baseline.id]: exp.results ?? {} },
    scenarioOrders: { [baseline.id]: exp.executionOrder ?? [] },
    previewResults: {},
    pendingFormulaChange: null,
    formulaRevision: exp.formulaRevision ?? 1,
    sharedFormulaRevision: exp.sharedFormulaRevision ?? (exp.formulaRevision ?? 1),
  };
}

export function effectiveUnits(units: ComputeUnit[], scenario: Scenario): ComputeUnit[] {
  return units.map((unit) => {
    if (unit.kind === "input" && Object.prototype.hasOwnProperty.call(scenario.parameterValues, unit.id)) {
      return { ...unit, value: scenario.parameterValues[unit.id] };
    }
    if (unit.kind === "formula" && scenario.formulaOverrides[unit.id]) {
      return { ...unit, expression: scenario.formulaOverrides[unit.id].expression };
    }
    return unit;
  });
}

export function unitsForPreview(exp: Experiment, scenario: Scenario): ComputeUnit[] {
  if (scenario.pendingFormulaRevision === null || !exp.pendingFormulaChange) return effectiveUnits(exp.units, scenario);
  const pending = exp.pendingFormulaChange;
  return effectiveUnits(
    exp.units.map((unit) => (unit.id === pending.unitId ? { ...unit, expression: pending.newExpression } : unit)),
    scenario,
  );
}

export function activeResults(exp: Experiment, scenarioId: string): Record<string, UnitResult> {
  const scenario = exp.scenarios[scenarioId];
  const accepted = exp.scenarioResults[scenarioId] ?? {};
  if (!scenario || scenario.pendingFormulaRevision === null) return accepted;
  return { ...accepted, ...(exp.previewResults[scenarioId] ?? {}) };
}

export function activeOrder(exp: Experiment, scenarioId: string): string[] {
  const scenario = exp.scenarios[scenarioId];
  const preview = exp.previewResults[scenarioId];
  if (scenario?.pendingFormulaRevision === null || !preview) return exp.scenarioOrders[scenarioId] ?? exp.executionOrder ?? [];
  return exp.scenarioOrders[scenarioId] ?? [];
}

export function runAcceptedScenario(exp: Experiment, scenarioId: string, changedIds?: string[]) {
  const scenario = exp.scenarios[scenarioId];
  const outcome = runGraph(effectiveUnits(exp.units, scenario), changedIds, exp.scenarioResults[scenarioId] ?? {});
  return {
    scenarioResults: { ...exp.scenarioResults, [scenarioId]: outcome.results },
    scenarioOrders: { ...exp.scenarioOrders, [scenarioId]: outcome.order },
    previewResults: exp.previewResults,
  };
}

export function previewFormulaChange(exp: Experiment, unitId: string, oldExpression: string, newExpression: string): Experiment {
  const unit = exp.units.find((item) => item.id === unitId);
  if (!unit || unit.kind !== "formula" || oldExpression === newExpression) return exp;
  const scenarios = { ...exp.scenarios };
  const previewResults: Experiment["previewResults"] = {};
  const scenarioOrders = { ...exp.scenarioOrders };
  const candidateUnits = exp.units.map((item) => (item.id === unitId ? { ...item, expression: newExpression } : item));

  for (const scenarioId of exp.scenarioOrder) {
    const scenario = scenarios[scenarioId];
    const outcome = runGraph(effectiveUnits(candidateUnits, scenario), [unitId], exp.scenarioResults[scenarioId] ?? {});
    previewResults[scenarioId] = outcome.results;
    scenarioOrders[scenarioId] = outcome.order;
    scenarios[scenarioId] = { ...scenario, pendingFormulaRevision: exp.formulaRevision };
  }

  return {
    ...exp,
    scenarios,
    previewResults,
    scenarioOrders,
    pendingFormulaChange: { unitId, oldExpression, newExpression, revision: exp.formulaRevision },
  };
}

function otherScenariosPending(exp: Experiment, scenarioId: string, scenarios: Record<string, Scenario>): boolean {
  return exp.scenarioOrder.some((id) => id !== scenarioId && scenarios[id]?.pendingFormulaRevision !== null);
}

export function acceptScenarioPreview(exp: Experiment, scenarioId: string): Experiment {
  const pending = exp.pendingFormulaChange;
  const preview = exp.previewResults[scenarioId];
  if (!pending || !preview) return exp;
  const scenarios = { ...exp.scenarios };
  const old = scenarios[scenarioId];
  const formulaOverrides = { ...old.formulaOverrides };
  formulaOverrides[pending.unitId] = { unitId: pending.unitId, expression: pending.newExpression, acceptedAt: Date.now(), revision: pending.revision };
  scenarios[scenarioId] = { ...old, pendingFormulaRevision: null, formulaOverrides };
  const previewResults = { ...exp.previewResults };
  delete previewResults[scenarioId];
  const stillPending = otherScenariosPending(exp, scenarioId, scenarios);
  return {
    ...exp,
    scenarios,
    previewResults,
    scenarioResults: { ...exp.scenarioResults, [scenarioId]: preview },
    pendingFormulaChange: stillPending ? pending : null,
  };
}

export function rejectScenarioPreview(exp: Experiment, scenarioId: string): Experiment {
  const pending = exp.pendingFormulaChange;
  if (!pending) return exp;
  const scenarios = { ...exp.scenarios };
  scenarios[scenarioId] = { ...scenarios[scenarioId], pendingFormulaRevision: null };
  const previewResults = { ...exp.previewResults };
  delete previewResults[scenarioId];
  const outcome = runGraph(effectiveUnits(exp.units, scenarios[scenarioId]), undefined, exp.scenarioResults[scenarioId] ?? {});
  const stillPending = otherScenariosPending(exp, scenarioId, scenarios);
  return {
    ...exp,
    scenarios,
    previewResults,
    scenarioResults: { ...exp.scenarioResults, [scenarioId]: outcome.results },
    scenarioOrders: { ...exp.scenarioOrders, [scenarioId]: outcome.order },
    pendingFormulaChange: stillPending ? pending : null,
  };
}

export function scenarioUnitRevision(units: ComputeUnit[], scenario: Scenario, unitId: string): string {
  const unit = effectiveUnits(units, scenario).find((item) => item.id === unitId);
  return unit ? unitRevision(unit) : "missing";
}
