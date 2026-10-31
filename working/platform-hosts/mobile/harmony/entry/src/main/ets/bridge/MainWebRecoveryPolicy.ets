export type MainWebRecoveryDecision = 'recover' | 'exhausted' | 'stale';

/** Limits automatic main-page recovery to one attempt per Index component lifetime. */
export class MainWebRecoveryPolicy {
  private activeGeneration: number = 0;
  private automaticRecoveryUsed: boolean = false;

  generation(): number { return this.activeGeneration; }

  isCurrent(generation: number): boolean { return generation === this.activeGeneration; }

  shouldRecoverHttpError(isMainFrame: boolean, statusCode: number): boolean {
    return isMainFrame && statusCode >= 400 && statusCode <= 599;
  }

  beginAutomaticRecovery(generation: number): MainWebRecoveryDecision {
    if (!this.isCurrent(generation)) return 'stale';
    this.activeGeneration += 1;
    if (this.automaticRecoveryUsed) return 'exhausted';
    this.automaticRecoveryUsed = true;
    return 'recover';
  }

  beginManualRetry(generation: number): number {
    if (!this.isCurrent(generation)) return -1;
    this.activeGeneration += 1;
    return this.activeGeneration;
  }
}
