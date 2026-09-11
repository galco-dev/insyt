// The batch yes (richer-platform spec §2.4, §3, §4): "Approve all safe
// fixes" on Home and Approvals, "Do all N fixes" on the report. One helper so
// the three doors behave the same: at active the batch is approved, below a
// plan the Plan sheet opens with the batch pending and finishes it after.
import { api } from './api.js';
import { useAccess } from './access.jsx';

// Safe = the categories Autopilot is allowed to do on its own.
export const SAFE_CATEGORIES = new Set(['negatives', 'counting']);
export const safeFixes = (pending) => (pending || []).filter((p) => SAFE_CATEGORIES.has(p.category));

export function useBatchApprove() {
  const { gate, bump } = useAccess();
  return async (items, title) => {
    const ids = (items || []).map((p) => p.id);
    if (!ids.length) return false;
    const run = async () => { await api('/api/app/approve-batch', { method: 'POST', body: { ids } }); bump(); };
    return gate(run, { kind: 'approve-batch', id: ids.join(','), title, run });
  };
}
