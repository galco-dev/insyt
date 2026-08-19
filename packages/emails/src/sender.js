// Outbound email drain — build-doc §12/§17.
// Pulls queued rows from the emails table and sends via Resend. Report-stream
// rows with a report_id send the frozen reports.html_email; transactional
// rows render their template from emails.payload. From-addresses per §17:
// transactional on alerts.tryinsyt.com, reports on mail.tryinsyt.com.
// List-Unsubscribe header on the report stream only.

const { renderTemplate } = require('./templates');

const FROM = {
  transactional: 'Insyt <hello@alerts.tryinsyt.com>',
  report: 'Insyt <reports@mail.tryinsyt.com>',
};

async function sendViaResend({ apiKey, to, from, subject, html, headers }, fetchImpl = fetch) {
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, ...(headers ? { headers } : {}) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`resend: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body.id;
}

/**
 * Drain up to `limit` queued emails. Injected db is the PostgREST client.
 * Returns { sent, failed } counts; failures are marked bounced with the
 * error in audit_log, never retried blindly.
 */
async function drainQueuedEmails({ db, apiKey, baseUrl, limit = 20, fetchImpl = fetch }) {
  const q = (s) => encodeURIComponent(s);
  const queued = await db.select('emails', `status=eq.queued&select=*&order=created_at.asc&limit=${limit}`);
  let sent = 0; let failed = 0;

  for (const email of queued) {
    try {
      if (!email.to_email) throw new Error('no recipient on row');
      let subject; let html;
      if (email.report_id) {
        const report = await db.select('reports', `id=eq.${q(email.report_id)}&select=html_email,type`, { single: true });
        if (!report || !report.html_email) throw new Error('report html missing');
        html = report.html_email;
        subject = (email.payload && email.payload.subject)
          || (report.type === 'signup' ? 'Your audit is ready' : 'Your weekly report');
      } else {
        const rendered = renderTemplate(email.template_id, { ...(email.payload || {}), base_url: baseUrl });
        subject = rendered.subject;
        html = rendered.html;
      }
      const headers = email.stream === 'report'
        ? { 'List-Unsubscribe': `<${baseUrl}/m/unsubscribe>` } : undefined;
      await sendViaResend({ apiKey, to: email.to_email, from: FROM[email.stream] || FROM.transactional, subject, html, headers }, fetchImpl);
      await db.update('emails', `id=eq.${q(email.id)}`, { status: 'sent', sent_at: new Date().toISOString() });
      sent += 1;
    } catch (err) {
      failed += 1;
      await db.update('emails', `id=eq.${q(email.id)}`, { status: 'bounced' }).catch(() => {});
      await db.insert('audit_log', [{ tenant_id: email.tenant_id, event: 'email_send_failed', detail: { email_id: email.id, error: String(err.message || err) } }], { returning: false }).catch(() => {});
    }
  }
  return { sent, failed };
}

module.exports = { drainQueuedEmails, sendViaResend, FROM };
