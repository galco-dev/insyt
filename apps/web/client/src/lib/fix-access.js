// Fix access (fix plan move 5). Ads changes ride on the read grant; changes
// to analytics and tracking need Google's write consent, asked once, at the
// first yes, in place. `next` brings the person back where they were.
export const needsWriteStep = (items, access) => !!(access && access.fix_access === 'ask' && (items || []).some((p) => p && p.needs_fix_access));
export const writeStepHref = (next = '/app') => `/auth/google/start?step=write&next=${encodeURIComponent(next)}`;
export const goWriteStep = (next) => { window.location.href = writeStepHref(next); };
export const FIX_ACCESS_LINE = 'First fix of this kind? Google will ask once for permission to change your analytics and tracking, then this applies within the hour.';
