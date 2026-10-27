'use strict';

const $ = (id) => document.getElementById(id);
const eur = (n) => n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const xaf = (n) => n.toLocaleString('fr-FR');

function show(el, text) {
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Erreur réseau');
  return body;
}

function initSend() {
  const params = new URLSearchParams(location.search);
  if (params.has('annule')) $('cancelled').classList.remove('hidden');
  api('/api/config').then((c) => c.sandbox && $('sandbox').classList.remove('hidden')).catch(() => {});

  let timer;
  async function refreshQuote() {
    try {
      const q = await api(`/api/quote?amount=${encodeURIComponent($('amount').value)}`);
      $('received').textContent = xaf(q.receivedXaf);
      $('fee').textContent = eur(q.feeEur);
      $('total').textContent = eur(q.totalEur);
      show($('quoteError'), '');
      const best = q.comparison[0];
      $('compare').replaceChildren(...q.comparison.map((c) => {
        const tr = document.createElement('tr');
        if (c === best) tr.className = 'best';
        for (const v of [c.name, eur(c.totalCostEur), `${xaf(c.receivedXaf)} FCFA`]) {
          const td = document.createElement('td');
          td.textContent = v;
          tr.append(td);
        }
        return tr;
      }));
    } catch (err) {
      $('received').textContent = '—';
      $('fee').textContent = '—';
      $('total').textContent = '—';
      show($('quoteError'), err.message);
    }
  }
  $('amount').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refreshQuote, 250); });
  refreshQuote();

  $('verify').addEventListener('click', async () => {
    const out = $('verifyResult');
    out.className = 'hint';
    out.textContent = 'Vérification…';
    try {
      const r = await api('/api/recipients/verify', {
        method: 'POST',
        body: JSON.stringify({ phone: $('recipientPhone').value }),
      });
      out.className = 'hint ok';
      out.textContent = `✓ Compte Airtel Money ${r.phone} au nom de ${r.holder}`;
    } catch (err) {
      out.className = 'hint error';
      out.textContent = err.message;
    }
  });

  $('sendForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!$('confirm').checked) return show($('formError'), 'Veuillez confirmer le numéro du bénéficiaire.');
    $('submit').disabled = true;
    show($('formError'), '');
    try {
      const r = await api('/api/transfers', {
        method: 'POST',
        body: JSON.stringify({
          amountEur: Number($('amount').value),
          recipientPhone: $('recipientPhone').value,
          recipientName: $('recipientName').value,
          senderName: $('senderName').value,
          senderEmail: $('senderEmail').value,
        }),
      });
      location.href = r.checkoutUrl;
    } catch (err) {
      show($('formError'), err.message);
      $('submit').disabled = false;
    }
  });
}

const STATUS = {
  awaiting_payment: ['En attente du paiement', 'pending'],
  paid: ['Paiement reçu, envoi en cours…', 'pending'],
  sending: ['Envoi vers Airtel Money en cours…', 'pending'],
  completed: ['Argent reçu sur Airtel Money ✓', 'ok'],
  failed: ['Échec de l’envoi, remboursement en cours', 'bad'],
  refunded: ['Échec de l’envoi – vous avez été remboursé', 'bad'],
  needs_review: ['Vérification en cours par notre équipe', 'pending'],
};

function initTrack() {
  const p = new URLSearchParams(location.search);
  const load = async () => {
    try {
      const t = await api(`/api/transfers/${encodeURIComponent(p.get('id') || '')}?t=${encodeURIComponent(p.get('t') || '')}`);
      const [label, kind] = STATUS[t.status] || [t.status, 'pending'];
      $('status').textContent = label;
      $('status').className = `status ${kind}`;
      const rows = [
        ['Bénéficiaire', `${t.recipientName} (${t.recipientPhone})`],
        ['Montant reçu', `${xaf(t.receivedXaf)} FCFA`],
        ['Montant envoyé', eur(t.amountEur)],
        ['Frais', eur(t.feeEur)],
        ['Total payé', eur(t.totalEur)],
      ];
      if (t.airtelRef) rows.push(['Référence Airtel', t.airtelRef]);
      $('details').replaceChildren(...rows.map(([k, v]) => {
        const div = document.createElement('div');
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = k;
        dd.textContent = v;
        div.append(dt, dd);
        return div;
      }));
      if (kind === 'pending') setTimeout(load, 4000);
    } catch (err) {
      $('status').textContent = err.message;
      $('status').className = 'status bad';
    }
  };
  load();
}

function initMockPay() {
  const session = new URLSearchParams(location.search).get('session') || '';
  $('pay').addEventListener('click', async () => {
    $('pay').disabled = true;
    try {
      const r = await api(`/api/mock-checkout/${encodeURIComponent(session)}/complete`, { method: 'POST' });
      location.href = r.redirect;
    } catch (err) {
      show($('payError'), err.message);
      $('pay').disabled = false;
    }
  });
}

({ send: initSend, track: initTrack, mockpay: initMockPay })[document.body.dataset.page]();
