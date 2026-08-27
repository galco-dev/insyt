// Minimal PostgREST client over fetch — no SDK dependency.
// Runs with the SERVICE ROLE key (workers/web are the service layer; RLS
// applies to end-user JWTs, not to us — build-doc §1 conventions).

function createClient({ url, serviceKey, fetchImpl = fetch }) {
  const base = url.replace(/\/$/, '') + '/rest/v1';
  const headers = {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    'content-type': 'application/json',
  };

  async function request(method, path, { body, prefer, single } = {}) {
    const res = await fetchImpl(`${base}/${path}`, {
      method,
      headers: {
        ...headers,
        ...(prefer ? { prefer } : {}),
        ...(single ? { accept: 'application/vnd.pgrst.object+json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 406 && single) return null; // no row for object request
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`postgrest ${method} ${path}: ${res.status} ${detail.slice(0, 300)}`);
    }
    if (res.status === 204) return null;
    // return=minimal answers 201 with an empty body - never try to parse that.
    if (res.status === 201 && (res.headers && res.headers.get && res.headers.get('content-length') === '0')) return null;
    try { return await res.json(); } catch (e) { if (res.status === 201) return null; throw e; }
  }

  return {
    select: (table, query, opts) => request('GET', `${table}?${query}`, opts),
    insert: (table, rows, { returning = true } = {}) => request('POST', table, {
      body: rows, prefer: returning ? 'return=representation' : 'return=minimal',
    }),
    upsert: (table, rows, onConflict) => request('POST', `${table}?on_conflict=${onConflict}`, {
      body: rows, prefer: 'resolution=merge-duplicates,return=representation',
    }),
    update: (table, query, patch) => request('PATCH', `${table}?${query}`, {
      body: patch, prefer: 'return=representation',
    }),
    rpc: (fn, args) => request('POST', `rpc/${fn}`, { body: args }),
  };
}

module.exports = { createClient };
