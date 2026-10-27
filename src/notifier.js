'use strict';

const money = (n, cur) => (cur === 'EUR'
  ? n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
  : `${n.toLocaleString('fr-FR')} FCFA`);

const WHERE = { airtel: 'Airtel Money', paypal: 'PayPal', sepa: 'compte bancaire' };

/** Construit le reçu envoyé à l'expéditeur quand un transfert se termine. */
function buildMessage(tr, user, publicUrl) {
  const track = `${publicUrl}/suivi.html?id=${tr.id}&t=${tr.access_token}`;
  const lines = [
    `Bonjour ${user.full_name},`,
    '',
    `Bénéficiaire : ${tr.recipient_name} (${WHERE[tr.payout_method]})`,
    `Montant reçu : ${money(tr.receive_amount, tr.receive_currency)}`,
    `Montant envoyé : ${money(tr.send_amount, tr.send_currency)}`,
    `Frais : ${money(tr.fee, tr.send_currency)}${tr.discount ? ` (dont ${money(tr.discount, tr.send_currency)} offerts)` : ''}`,
    `Total payé : ${money(tr.total, tr.send_currency)}`,
    `Référence : ${tr.id}`,
    '',
    `Suivi : ${track}`,
  ];
  const subjects = {
    completed: `Votre envoi de ${money(tr.receive_amount, tr.receive_currency)} est arrivé`,
    refunded: 'Votre envoi a échoué : vous avez été remboursé',
    cancelled: 'Votre envoi a été annulé',
  };
  const intro = {
    completed: `L'argent est disponible pour ${tr.recipient_name}.`,
    refunded: `L'envoi n'a pas pu aboutir. Le total de ${money(tr.total, tr.send_currency)} vous a été remboursé.`,
    cancelled: 'Le paiement n’a pas été validé : rien n’a été débité.',
  };
  return { subject: subjects[tr.status], text: [lines[0], '', intro[tr.status], ...lines.slice(1)].join('\n') };
}

/** Envoi d'e-mails transactionnels via l'API Brevo. */
class BrevoNotifier {
  constructor({ apiKey, sender }, fetchImpl = fetch) {
    this.apiKey = apiKey;
    this.sender = sender;
    this.fetch = fetchImpl;
  }
  async send(to, { subject, text }) {
    const res = await this.fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender: this.sender, to: [{ email: to }], subject, textContent: text }),
    });
    if (!res.ok) throw new Error(`Brevo HTTP ${res.status}`);
  }
}

/** En démo, les e-mails sont affichés dans la console. */
class ConsoleNotifier {
  constructor(logger = console) {
    this.logger = logger;
    this.sent = [];
  }
  async send(to, message) {
    this.sent.push({ to, ...message });
    this.logger.log(`[e-mail simulé → ${to}] ${message.subject}`);
  }
}

module.exports = { buildMessage, BrevoNotifier, ConsoleNotifier };
