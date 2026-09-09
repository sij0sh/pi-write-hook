// Single pending mutation slot plus hook acknowledgement.
// Pending state lives in extension memory only and never crosses sessions.

import type { MutationTool } from "../hooks/match.ts";

export interface PendingMutation {
  tool: MutationTool;
  path: string;
  absolutePath: string;
  args: unknown;
  hookFingerprint: string;
  contextFingerprint: string;
  observedTurn: number;
}

export interface HookAck {
  tool: MutationTool;
  absolutePath: string;
  hookFingerprint: string;
  contextFingerprint: string;
  observedTurn: number;
}

export interface HookMetrics {
  hookedFirstAttempts: number;
  finalizedUnchanged: number;
  revisedBeforeCommit: number;
  pendingTargetMismatches: number;
  stalePendingInvalidations: number;
  sameTurnDecisionAttempts: number;
}

export function emptyMetrics(): HookMetrics {
  return {
    hookedFirstAttempts: 0,
    finalizedUnchanged: 0,
    revisedBeforeCommit: 0,
    pendingTargetMismatches: 0,
    stalePendingInvalidations: 0,
    sameTurnDecisionAttempts: 0,
  };
}

export class PendingState {
  pending: PendingMutation | null = null;
  acknowledged: HookAck | null = null;
  currentTurn = 0;
  restoreActive: string[] | null = null;
  metrics: HookMetrics = emptyMetrics();

  setTurn(turn: number): void {
    this.currentTurn = turn;
  }

  enter(
    pending: PendingMutation,
    activeTools: string[],
  ): void {
    if (!this.pending) this.restoreActive = [...activeTools];
    this.pending = pending;
    this.acknowledged = {
      tool: pending.tool,
      absolutePath: pending.absolutePath,
      hookFingerprint: pending.hookFingerprint,
      contextFingerprint: pending.contextFingerprint,
      observedTurn: pending.observedTurn,
    };
    this.metrics.hookedFirstAttempts += 1;
  }

  take(): { pending: PendingMutation; restoreActive: string[] | null } {
    const pending = this.pending;
    const restoreActive = this.restoreActive;
    this.pending = null;
    this.restoreActive = null;
    return { pending: pending as PendingMutation, restoreActive };
  }

  clear(): void {
    this.pending = null;
    this.restoreActive = null;
  }

  clearAll(): void {
    this.pending = null;
    this.acknowledged = null;
    this.restoreActive = null;
  }

  isAcknowledged(
    tool: MutationTool,
    absolutePath: string,
    hookFingerprint: string,
    contextFingerprint: string,
  ): boolean {
    const ack = this.acknowledged;
    return (
      !!ack &&
      ack.tool === tool &&
      ack.absolutePath === absolutePath &&
      ack.hookFingerprint === hookFingerprint &&
      ack.contextFingerprint === contextFingerprint
    );
  }

  fingerprintsCurrent(hookFingerprint: string, contextFingerprint: string): boolean {
    return (
      !!this.pending &&
      this.pending.hookFingerprint === hookFingerprint &&
      this.pending.contextFingerprint === contextFingerprint
    );
  }
}
