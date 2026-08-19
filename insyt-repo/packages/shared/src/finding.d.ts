/**
 * Findings JSON contract — build-doc §2, schema_version 1.
 * The single schema between the rules engine and everything downstream.
 * Breaking changes bump schema_version.
 */

export type Severity = 'critical' | 'warning' | 'opportunity' | 'info';
export type FindingStatus = 'open' | 'approved' | 'applied' | 'dismissed' | 'resolved' | 'suspect';
export type MoneyConfidence = 'measured' | 'estimated' | 'none';
export type ApprovalScope = 'change' | 'changeset' | 'campaign_launch';

export interface Money {
  impact_monthly_usd: number;
  impact_monthly_local?: { amount: number; currency: string };
  direction: 'waste' | 'opportunity';
  confidence: MoneyConfidence;
}

export interface Evidence {
  metrics: Record<string, number>;
  window_days: number;
  /** Versioned SQL refs, e.g. "sql/rules/ads_wasted_terms.sql@v3" */
  queries: string[];
}

/** The $20 blur boundary. Enforced server-side — never sent to unpaid sessions. */
export interface Payload {
  locked: boolean;
  entities: Array<{ kind: string; value: string; [metric: string]: unknown }>;
  fix_detail: string;
}

export interface Fix {
  available: boolean;
  tool_id: string;
  params_ref: string;
  risk: 'low' | 'medium' | 'high';
  reversible: boolean;
  approval_scope: ApprovalScope;
}

export interface Finding {
  schema_version: 1;
  finding_id: string;
  run_id: string;
  tenant_id: string;
  rule_id: string;
  layer: 1 | 2 | 3 | 4 | 5;
  severity: Severity;
  status: FindingStatus;
  category: string;
  first_seen_run_id: string;
  /** Sonnet-written from the rest of the object. Never derives numbers. */
  title: string;
  explanation: string;
  money: Money;
  evidence: Evidence;
  payload: Payload;
  fix: Fix;
  display: { icon: string; badge_color: Severity; sort_weight: number };
}

export interface RunEnvelope {
  schema_version: 1;
  run_id: string;
  type: 'signup_audit' | 'weekly' | 'deep' | 'triggered' | 'verification';
  completed: boolean;
  degraded: boolean;
  degraded_reasons: string[];
  counts: Record<Severity, number>;
  totals: {
    waste_monthly_usd: number;
    applied_this_run: number;
    ledger_cumulative: { fixes: number; waste_removed_usd: number };
  };
  narrative_slots: {
    exec_summary: string;
    since_last_week: string;
    deep_synthesis?: string;
  };
  findings: Finding[];
}
