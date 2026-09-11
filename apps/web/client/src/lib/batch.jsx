// The batch yes (richer-platform spec §2.4, §3, §4): "Approve all safe
// fixes" on Home and Approvals, "Do all N fixes" on the report. One helper so
// the three doors behave the same: at active the batch is approved, below a
// plan the Plan sheet opens with the batch pending and finishes it after.
import { api } from './api.js';
import { useAccess } from './access.jsx';
import { needsWriteStep, goWriteStep } from './fix-access.js';

// Safe = the categories Autopilot is allowed to do on its own.
export const SAFE_CATEGORIES = new Set(['negatives', 'counting']);
export const safeFixes = (pending) => (pending || []).filter((p) => SAFE_CATEGORIES.has(p.category));

export function useBatchApprove() {
  const { gate, bump, access, path } = useAccess();
  return async (items, title) => {
    const ids = (items || []).map((p) => p.id);
    if (!ids.length) return false;
    const run = async () => { await api('/api/app/approve-batch', { method: 'POST', body: { ids } }); bump(); };
    const ran = await gate(run, { kind: 'approve-batch', id: ids.join(','), title, run });
    if (ran && needsWriteStep(items, access)) goWriteStep(path || '/app');
    return ran;
  };
}
