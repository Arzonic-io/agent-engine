export interface GuardrailConfig {
  /** Hard cap on builder rounds. The loop is provably terminating because of this. */
  maxRounds: number;
  /** Optional total-token cap per run; the run is marked failed when exceeded. */
  tokenBudget?: number;
}

export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  maxRounds: 3,
};

export function isBudgetExceeded(
  tokensUsed: number,
  guardrails: GuardrailConfig,
): boolean {
  return (
    guardrails.tokenBudget !== undefined && tokensUsed > guardrails.tokenBudget
  );
}
