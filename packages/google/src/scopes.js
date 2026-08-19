// OAuth scope ladder — build-doc §6.
// Identity login ≠ data scopes. Four steps, each requested only at its moment:
//   1 signin     — openid/email/profile (Supabase Auth handles this one)
//   2 discovery  — read-only Ads/GA4/GTM, asked immediately after sign-in
//   3 write      — asked at the first-fix ceremony, never earlier
//   4 create     — Journey B provisioning, asked at the pay-then-build moment
// scope_level on google_connections derives from what was actually granted.

const SCOPES = {
  OPENID: 'openid',
  EMAIL: 'https://www.googleapis.com/auth/userinfo.email',
  PROFILE: 'https://www.googleapis.com/auth/userinfo.profile',
  ADWORDS: 'https://www.googleapis.com/auth/adwords',
  ANALYTICS_RO: 'https://www.googleapis.com/auth/analytics.readonly',
  TAGMANAGER_RO: 'https://www.googleapis.com/auth/tagmanager.readonly',
  ANALYTICS_EDIT: 'https://www.googleapis.com/auth/analytics.edit',
  TAGMANAGER_EDIT: 'https://www.googleapis.com/auth/tagmanager.edit.containers',
  TAGMANAGER_PUBLISH: 'https://www.googleapis.com/auth/tagmanager.publish',
};

// What each ladder step ASKS for (incremental — previous grants carry over
// via include_granted_scopes, so each step lists only its additions).
const LADDER = {
  signin: [SCOPES.OPENID, SCOPES.EMAIL, SCOPES.PROFILE],
  discovery: [SCOPES.ADWORDS, SCOPES.ANALYTICS_RO, SCOPES.TAGMANAGER_RO],
  write: [SCOPES.ANALYTICS_EDIT, SCOPES.TAGMANAGER_EDIT, SCOPES.TAGMANAGER_PUBLISH],
  // Journey B create: GA4 provisioning rides on analytics.edit; Ads
  // CreateCustomerClient rides on adwords under our MCC — no new scopes,
  // but the step exists so consent copy and audit trail mark the moment.
  create: [],
};

// What each level REQUIRES to be considered fully granted.
const LEVEL_REQUIREMENTS = {
  readonly: [SCOPES.ADWORDS, SCOPES.ANALYTICS_RO, SCOPES.TAGMANAGER_RO],
  write: [
    SCOPES.ADWORDS, SCOPES.ANALYTICS_RO, SCOPES.TAGMANAGER_RO,
    SCOPES.ANALYTICS_EDIT, SCOPES.TAGMANAGER_EDIT, SCOPES.TAGMANAGER_PUBLISH,
  ],
  create: [
    SCOPES.ADWORDS, SCOPES.ANALYTICS_RO, SCOPES.TAGMANAGER_RO,
    SCOPES.ANALYTICS_EDIT, SCOPES.TAGMANAGER_EDIT, SCOPES.TAGMANAGER_PUBLISH,
  ],
};

/** Highest fully-satisfied scope_level for a set of granted scopes, or null. */
function scopeLevel(granted) {
  const have = new Set(granted || []);
  const satisfies = (level) => LEVEL_REQUIREMENTS[level].every((s) => have.has(s));
  if (satisfies('create')) return 'create'; // same scopes as write in v1; kept distinct for §6 step 4
  if (satisfies('write')) return 'write';
  if (satisfies('readonly')) return 'readonly';
  return null;
}

/**
 * Scopes missing for a requested level. Non-empty result on a connection that
 * should have that level means `partial` — runs degrade honestly (§6).
 */
function missingScopes(granted, level) {
  const have = new Set(granted || []);
  return LEVEL_REQUIREMENTS[level].filter((s) => !have.has(s));
}

module.exports = { SCOPES, LADDER, LEVEL_REQUIREMENTS, scopeLevel, missingScopes };
