/** Repository-owned historical landmarks. No product snapshot configuration exists. */

interface LandmarkDiagnostic { ref: string; object: string; reason: string }
/** This plan is stored in the same database snapshot as its graph, never a sidecar. */
export interface LandmarkPlan {
  head: string;
  snapshots: Record<string, string>;
  points: string[];
  limit: number;
  omitted: number;
  diagnostics: LandmarkDiagnostic[];
}
export interface LandmarkCoverage {
  offered: number;
  covered: number;
  limit: number;
  overflow: boolean;
  omitted: number;
  /** Bounds of individually covered trees, NOT a continuous covered interval. */
  first: string | null;
  last: string | null;
  diagnostics: LandmarkDiagnostic[];
}
