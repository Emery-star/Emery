'use strict';

const crypto = require('node:crypto');

/** Encaissement par carte bancaire via Stripe Checkout. */
class StripePayments {
  constructor(cfg, publicUrl) {
    const Stripe = require('stripe');
    this.stripe = new Stripe(cfg.secretKey);
    this.webhookSecret = cfg.webhookSecret;
    this.publicUrl = publicUrl;
  }

  async createCheckout(transfer) {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        customer_email: transfer.sender_email,
        client_reference_id: transfer.id,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'eur',
              unit_amount: Math.round(transfer.total_eur * 100),
              product_data: {
                name: `Envoi Airtel Money Gabon – ${transfer.received_xaf.toLocaleString('fr-FR')} FCFA`,
                description: `Pour ${transfer.recipient_name}, frais inclus`,
              },
            },
          },
        ],
        metadata: { transfer_id: transfer.id },
        success_url: `${this.publicUrl}/suivi.html?id=${transfer.id}&t=${transfer.access_token}`,
        cancel_url: `${this.publicUrl}/?annule=1`,
      },
      { idempotencyKey: `checkout-${transfer.id}` },
    );
    return { checkoutId: session.id, url: session.url };
  }

  /** Vérifie la signature et retourne { transferId, paymentRef } si le paiement est confirmé. */
  parseWebhook(rawBody, signature) {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    if (event.type !== 'checkout.session.completed') return null;
    const s = event.data.object;
    if (s.payment_status !== 'paid') return null;
    return {
      transferId: s.metadata && s.metadata.transfer_id,
      checkoutId: s.id,
      paymentRef: s.payment_intent,
      amountCents: s.amount_total,
    };
  }

  async refund(paymentRef) {
    await this.stripe.refunds.create({ payment_intent: paymentRef }, { idempotencyKey: `refund-${paymentRef}` });
  }
}

/** Paiement simulé : une page locale remplace Stripe Checkout. */
class MockPayments {
  constructor(publicUrl) {
    this.publicUrl = publicUrl;
    this.refunds = [];
  }
  async createCheckout(transfer) {
    const checkoutId = `mock_cs_${crypto.randomBytes(8).toString('hex')}`;
    return { checkoutId, url: `${this.publicUrl}/paiement-test.html?session=${checkoutId}` };
  }
  async refund(paymentRef) {
    this.refunds.push(paymentRef);
  }
}

module.exports = { StripePayments, MockPayments };
