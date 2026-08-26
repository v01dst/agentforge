import type { ApprovalDecision, ApprovalRequest } from './permissions.js';

export interface PendingApproval extends ApprovalRequest {
  id: string;
}

type Listener = (pending: PendingApproval[]) => void;

let seq = 0;
let queue: PendingApproval[] = [];
const listeners = new Set<Listener>();
const resolvers = new Map<string, (decision: ApprovalDecision) => void>();

function notify(): void {
  const snapshot = [...queue];
  for (const listener of listeners) listener(snapshot);
}

/**
 * Push an approval request and wait for the UI (or a test) to decide.
 * Resolves with `{ approved: false }` if nobody is listening, so headless
 * contexts fail closed instead of hanging.
 */
export function requestToolApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
  if (listeners.size === 0) return Promise.resolve({ approved: false });
  const id = `approval-${++seq}`;
  return new Promise<ApprovalDecision>((resolvePromise) => {
    resolvers.set(id, resolvePromise);
    queue = [...queue, { ...request, id }];
    notify();
  });
}

/** Decide a pending request by id. Unknown ids are ignored. */
export function resolveToolApproval(id: string, decision: ApprovalDecision): void {
  const resolver = resolvers.get(id);
  if (!resolver) return;
  resolvers.delete(id);
  queue = queue.filter((entry) => entry.id !== id);
  notify();
  resolver(decision);
}

/** Subscribe to the pending-approval queue; returns an unsubscribe fn. */
export function subscribeApprovals(listener: Listener): () => void {
  listeners.add(listener);
  listener([...queue]);
  return () => listeners.delete(listener);
}

/** Test helper: drop everything without deciding. */
export function clearApprovals(): void {
  for (const [id, resolver] of [...resolvers]) {
    resolver({ approved: false });
  }
  queue = [];
  notify();
}
