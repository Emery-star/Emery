'use strict';

const $ = (id) => document.getElementById(id);
const money = (n, cur) => cur === 'EUR'
  ? n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
  : `${n.toLocaleString('fr-FR')} FCFA`;

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

  const state = { direction: 'fr_to_ga', pay: 'card', payout: 'airtel', methods: null, amounts: { fr_to_ga: 100, ga_to_fr: 65000 } };

  function renderChips(container, list, key) {
    container.replaceChildren(...list.map((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.disabled = !m.available;
      b.setAttribute('aria-pressed', String(state[key] === m.id));
      b.textContent = m.label;
      if (m.soon) b.append(Object.assign(document.createElement('small'), { textContent: 'Bientôt' }));
      else if (m.surcharge) b.append(Object.assign(document.createElement('small'), { textContent: `+${state.fees.paypalSurchargePercent} %` }));
      else if (!m.available) b.append(Object.assign(document.createElement('small'), { textContent: 'Indisponible' }));
      b.addEventListener('click', () => { state[key] = m.id; render(); });
      return b;
    }));
  }

  function render() {
    const m = state.methods[state.direction];
    const firstAvail = (list) => (list.find((x) => x.available) || list[0]).id;
    if (!m.pay.some((x) => x.id === state.pay && x.available)) state.pay = firstAvail(m.pay);
    if (!m.payout.some((x) => x.id === state.payout && x.available)) state.payout = firstAvail(m.payout);

    for (const t of document.querySelectorAll('[data-dir]')) t.setAttribute('aria-selected', String(t.dataset.dir === state.direction));
    for (const el of document.querySelectorAll('[data-for]')) el.classList.toggle('hidden', el.dataset.for !== state.direction);
    for (const el of document.querySelectorAll('[data-payout]')) el.classList.toggle('hidden', el.dataset.payout !== state.payout);

    const fr = state.direction === 'fr_to_ga';
    $('sendCur').textContent = fr ? 'EUR' : 'FCFA';
    $('recvCur').textContent = fr ? 'FCFA' : 'EUR';
    $('amount').step = fr ? '1' : '500';
    $('payLabel').textContent = 'Vous payez avec';
    $('payoutLabel').textContent = fr ? 'Le bénéficiaire reçoit sur' : 'Le bénéficiaire reçoit sur son';
    renderChips($('payChips'), m.pay, 'pay');
    renderChips($('payoutChips'), m.payout, 'payout');
    $('submit').textContent = fr
      ? (state.pay === 'paypal' ? 'Payer avec PayPal' : 'Payer par carte')
      : 'Recevoir la demande de paiement Airtel';
    refreshQuote();
  }

  let timer;
  async function refreshQuote() {
    const qs = new URLSearchParams({ direction: state.direction, amount: $('amount').value, pay: state.pay, payout: state.payout });
    try {
      const q = await api(`/api/quote?${qs}`);
      const cur = q.sendCurrency;
      $('received').textContent = q.receiveAmount.toLocaleString('fr-FR', { minimumFractionDigits: cur === 'XAF' ? 2 : 0 });
      $('fee').textContent = money(q.fee, cur);
      $('discount').textContent = `− ${money(q.firstTransferDiscount, cur)}`;
      $('total').textContent = money(q.total, cur);
      $('totalFirst').textContent = money(cur === 'EUR' ? Math.round((q.total - q.firstTransferDiscount) * 100) / 100 : q.total - q.firstTransferDiscount, cur);
      show($('quoteError'), '');
      $('compare').replaceChildren(...q.comparison.map((c, i) => {
        const tr = document.createElement('tr');
        if (i === 0) tr.className = 'best';
        for (const v of [c.name, money(c.cost, cur), money(c.receive, q.receiveCurrency)]) {
          const td = document.createElement('td');
          td.textContent = v;
          tr.append(td);
        }
        return tr;
      }));
    } catch (err) {
      for (const id of ['received', 'fee', 'discount', 'total', 'totalFirst']) $(id).textContent = '—';
      $('compare').replaceChildren();
      show($('quoteError'), err.message);
    }
  }

  for (const t of document.querySelectorAll('[data-dir]')) {
    t.addEventListener('click', () => {
      state.amounts[state.direction] = $('amount').value;
      state.direction = t.dataset.dir;
      $('amount').value = state.amounts[state.direction];
      render();
    });
  }
  $('amount').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refreshQuote, 250); });

  api('/api/config').then((c) => {
    if (c.mode === 'demo') $('sandbox').classList.remove('hidden');
    state.methods = c.methods;
    state.fees = c.fees;
    $('promoText').textContent = `Jusqu’à ${money(c.fees.firstTransferFreeMaxEur, 'EUR')} offerts. Ensuite ${money(c.fees.smallFeeEur, 'EUR')} seulement jusqu’à ${c.fees.smallLimitEur} €.`;
    render();
  }).catch((err) => show($('quoteError'), err.message));

  $('verify').addEventListener('click', async () => {
    const out = $('verifyResult');
    out.className = 'hint';
    out.textContent = 'Vérification…';
    try {
      const r = await api('/api/recipients/verify', { method: 'POST', body: JSON.stringify({ phone: $('recipientPhone').value }) });
      out.className = 'hint ok';
      out.textContent = `✓ Compte Airtel Money ${r.phone} au nom de ${r.holder}`;
    } catch (err) {
      out.className = 'hint error';
      out.textContent = err.message;
    }
  });

  $('sendForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!$('confirm').checked) return show($('formError'), 'Cochez la case pour confirmer les coordonnées du bénéficiaire.');
    $('submit').disabled = true;
    show($('formError'), '');
    try {
      const r = await api('/api/transfers', {
        method: 'POST',
        body: JSON.stringify({
          direction: state.direction,
          payMethod: state.pay,
          payoutMethod: state.payout,
          amount: Number($('amount').value),
          recipientName: $('recipientName').value,
          recipientPhone: $('recipientPhone').value,
          recipientIban: $('recipientIban').value,
          recipientEmail: $('recipientEmail').value,
          senderName: $('senderName').value,
          senderEmail: $('senderEmail').value,
          senderPhone: $('senderPhone').value,
        }),
      });
      location.href = r.nextUrl;
    } catch (err) {
      show($('formError'), err.message);
      $('submit').disabled = false;
    }
  });
}

const PAYOUT = { airtel: 'Airtel Money', paypal: 'PayPal', sepa: 'compte bancaire' };

function statusLabel(t) {
  const where = PAYOUT[t.payoutMethod];
  const refundTo = t.payMethod === 'airtel' ? 'sur votre Airtel Money' : t.payMethod === 'paypal' ? 'sur votre PayPal' : 'sur votre carte';
  return {
    awaiting_payment: [t.payMethod === 'airtel' ? 'En attente de votre validation sur Airtel Money' : 'En attente du paiement', 'pending'],
    paid: ['Paiement reçu, envoi en cours…', 'pending'],
    sending: [t.payoutMethod === 'sepa' ? 'Virement en cours (arrivée sous 1 jour ouvré au plus)' : `Envoi vers ${where} en cours…`, 'pending'],
    completed: [`Argent envoyé sur ${t.payoutMethod === 'sepa' ? 'le compte bancaire' : where} ✓`, 'ok'],
    failed: ['Échec de l’envoi, remboursement en cours', 'bad'],
    refunded: [`Échec de l’envoi : vous avez été remboursé ${refundTo}`, 'bad'],
    cancelled: ['Paiement non validé : rien n’a été débité', 'bad'],
    needs_review: ['Vérification en cours par notre équipe', 'pending'],
  }[t.status] || [t.status, 'pending'];
}

function initTrack() {
  const p = new URLSearchParams(location.search);
  const id = encodeURIComponent(p.get('id') || '');
  const tok = encodeURIComponent(p.get('t') || '');
  let demo = false;
  api('/api/config').then((c) => { demo = c.mode === 'demo'; }).catch(() => {});

  function paint(t) {
    const [label, kind] = statusLabel(t);
    $('status').textContent = label;
    $('status').className = `status ${kind}`;
    const waitingPin = t.status === 'awaiting_payment' && t.payMethod === 'airtel';
    $('pinBox').classList.toggle('hidden', !waitingPin);
    $('demoPin').classList.toggle('hidden', !(waitingPin && demo));
    const rows = [
      ['Bénéficiaire', `${t.recipientName} (${PAYOUT[t.payoutMethod]} ${t.recipientAccount})`],
      ['Montant reçu', money(t.receiveAmount, t.receiveCurrency)],
      ['Montant envoyé', money(t.sendAmount, t.sendCurrency)],
      ['Frais', money(t.fee, t.sendCurrency)],
    ];
    if (t.discount > 0) rows.push(['Premier envoi offert', `− ${money(t.discount, t.sendCurrency)}`]);
    rows.push(['Total payé', money(t.total, t.sendCurrency)]);
    if (t.payoutRef) rows.push(['Référence', t.payoutRef]);
    if (t.failureReason) rows.push(['Motif', t.failureReason]);
    $('details').replaceChildren(...rows.map(([k, v]) => {
      const div = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v;
      div.append(dt, dd);
      return div;
    }));
    return kind === 'pending';
  }

  const load = async () => {
    try {
      if (paint(await api(`/api/transfers/${id}?t=${tok}`))) setTimeout(load, 4000);
    } catch (err) {
      $('status').textContent = err.message;
      $('status').className = 'status bad';
    }
  };
  $('demoPin').addEventListener('click', async () => {
    $('demoPin').disabled = true;
    try {
      paint(await api(`/api/demo/airtel-pin/${id}?t=${tok}`, { method: 'POST' }));
    } finally {
      $('demoPin').disabled = false;
    }
  });
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
