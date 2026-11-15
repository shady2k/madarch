/**
 * Host API for the additive assertion prerequisites. The assertion storage cutover can use these
 * without changing legacy opinion readers: pin a context once, resolve evidence in the caller's
 * transaction, and reserve a stable assertion identity per retained operation and logical slot.
 *
 * These functions require a host-owned SqlExecutor; this is not a plugin writer capability.
 * Resolution never creates evidence targets, and retry reservations store no assertion facts.
 */
export { contextLayers, nextGraphRecordedSequence, pinContext, type ContextLayer } from './graph/context.js';
export { resolveEvidenceTargets, EvidenceTargetError, type EvidenceLocatorDraft, type EvidenceTarget, type EvidenceTargetKinds } from './graph/evidence-targets.js';
export { reserveAssertionIdentity } from './graph/operation-identity.js';
