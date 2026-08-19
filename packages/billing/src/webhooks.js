// Stripe webhook handling — build-doc §10. Stripe is the source of truth;
// our subscriptions table is a cache mirrored here. The grace ladder degrades,
// it never cuts (master §11): monitoring continues through failed payments.
//
// store (injected):
//   upsertSubscription(row), markSubscription(stripe_subscription_id, patch)
//   recordPayment(row), ledger(entry), audit(entry)
//   scheduleEmail(template_id, tenant_id, vars)
//   tenantIdByCustomer(stripe_customer_id) -> tenant_id

const GRACE_RETRY_DAYS = [3, 5, 7]; // §10 grace ladder

// Tenant resolution: checkout.js stamps metadata.tenant_id (and
// client_reference_id) on everything it creates, so fresh customers resolve
// before any subscriptions row exists; customer lookup is the fallback.
async function tenantFor(obj, store) {
  return (obj.metadata && obj.metadata.tenant_id)
    || obj.client_reference_id
    || store.tenantIdByCustomer(obj.customer);
}

async function handleWebhook(event, store) {
  const type = event.type;
  const obj = event.data.object;

  switch (type) {
    case 'checkout.session.completed': {
      const tenantId = await tenantFor(obj, store);
      if (obj.mode === 'payment') {
        const kind = obj.metadata && obj.metadata.kind; // audit_unlock | large_audit | setup_bundle
        await store.recordPayment({
          tenant_id: tenantId,
          kind: kind || 'audit_unlock',
          stripe_payment_intent: obj.payment_intent,
          amount_usd: (obj.amount_total || 0) / 100,
        });
        await store.audit({ tenant_id: tenantId, event: 'checkout_completed', detail: { kind, session: obj.id } });
      }
      return { handled: true };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const tenantId = await tenantFor(obj, store);
      await store.upsertSubscription({
        tenant_id: tenantId,
        stripe_customer_id: obj.customer,
        stripe_subscription_id: obj.id,
        tier: obj.metadata && obj.metadata.tier,
        size_band: obj.metadata && obj.metadata.band,
        price_usd: obj.items && obj.items.data[0] ? obj.items.data[0].price.unit_amount / 100 : null,
        status: obj.status,
        current_period_end: obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null,
      });
      await store.ledger({ tenant_id: tenantId, event: 'subscription_changed', actor: 'system', summary_text: `Plan ${obj.status}` });
      return { handled: true };
    }
    case 'customer.subscription.deleted': {
      const tenantId = await tenantFor(obj, store);
      await store.markSubscription(obj.id, { status: 'canceled' });
      await store.ledger({ tenant_id: tenantId, event: 'subscription_changed', actor: 'system', summary_text: 'Plan cancelled' });
      return { handled: true };
    }
    case 'invoice.paid': {
      const tenantId = await tenantFor(obj, store);
      if (obj.subscription) await store.markSubscription(obj.subscription, { status: 'active' });
      await store.audit({ tenant_id: tenantId, event: 'invoice_paid', detail: { invoice: obj.id, amount_usd: (obj.amount_paid || 0) / 100 } });
      return { handled: true };
    }
    case 'invoice.payment_failed': {
      const tenantId = await tenantFor(obj, store);
      const attempt = obj.attempt_count || 1;
      // Degrade, never cut: subscription stays mirrored as-is; we email the
      // grace ladder and let Stripe's retry schedule run its course.
      await store.markSubscription(obj.subscription, { status: 'past_due' });
      await store.scheduleEmail('card_failed_grace', tenantId, {
        attempt,
        next_retry_days: GRACE_RETRY_DAYS[Math.min(attempt - 1, GRACE_RETRY_DAYS.length - 1)],
      });
      await store.audit({ tenant_id: tenantId, event: 'payment_failed', detail: { invoice: obj.id, attempt } });
      return { handled: true };
    }
    default:
      return { handled: false };
  }
}

module.exports = { handleWebhook, GRACE_RETRY_DAYS };
