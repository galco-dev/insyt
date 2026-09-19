// Google Ads account creation under Insyt's manager account (launch journey,
// 19 Sep 2026). For a business that signs in with no Ads account at all.
//
// The call needs Insyt's own credentials, a user who administers the manager
// account, not the customer's: GOOGLE_ADS_MANAGER_REFRESH_TOKEN. Without it
// the door stays shut and the confirm step offers the other routes.
//
// What Google does with one call: creates a standalone account linked under
// the manager, and invites the customer's Google login as an administrator.
// The account is theirs: they accept the invitation, add a card under
// Billing (Google charges it for clicks, never Insyt), and can remove our
// access at any time. Currency and time zone cannot be changed afterwards.
//
//   createAdsAccount({ clientId, clientSecret, managerRefreshToken, developerToken, managerId,
//                      descriptiveName, currency, timeZone, ownerEmail, fetchImpl })
//     -> { customer_id, formatted, invitation_link }

const { refreshAccessToken } = require('./oauth');

const VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v24';
const CURRENCIES = ['USD', 'GBP', 'EUR', 'AED', 'AUD', 'CAD', 'NZD', 'SAR', 'ZAR', 'INR', 'SGD'];

function formatCustomerId(id) {
  const d = String(id || '').replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
}

async function createAdsAccount({ clientId, clientSecret, managerRefreshToken, developerToken, managerId, descriptiveName, currency = 'USD', timeZone = 'UTC', ownerEmail = null, fetchImpl = fetch }) {
  if (!managerRefreshToken) throw new Error('manager credentials not configured');
  const cur = CURRENCIES.includes(String(currency).toUpperCase()) ? String(currency).toUpperCase() : 'USD';
  const r = await refreshAccessToken({ clientId, clientSecret, refreshToken: managerRefreshToken }, fetchImpl);
  if (r.error) throw new Error(`manager token refresh failed: ${JSON.stringify(r.error).slice(0, 160)}`);
  const mid = String(managerId).replace(/-/g, '');
  const res = await fetchImpl(`https://googleads.googleapis.com/${VERSION}/customers/${mid}:createCustomerClient`, {
    method: 'POST',
    headers: { authorization: `Bearer ${r.tokens.access_token}`, 'developer-token': developerToken, 'login-customer-id': mid, 'content-type': 'application/json' },
    body: JSON.stringify({
      customerClient: { descriptiveName: String(descriptiveName || 'New account').slice(0, 120), currencyCode: cur, timeZone },
      ...(ownerEmail ? { emailAddress: ownerEmail, accessRole: 'ADMIN' } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`google ads ${res.status}: ${JSON.stringify(body.error || body).slice(0, 300)}`);
    err.code = body.error && body.error.status ? body.error.status : `HTTP_${res.status}`;
    throw err;
  }
  const customerId = String(body.resourceName || '').split('/').pop();
  if (!customerId) throw new Error('google ads: no account id in the answer');
  return { customer_id: customerId, formatted: formatCustomerId(customerId), invitation_link: body.invitationLink || null, currency: cur, time_zone: timeZone };
}

module.exports = { createAdsAccount, formatCustomerId, CURRENCIES };
