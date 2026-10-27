'use strict';

const $ = (id) => document.getElementById(id);
const money = (n, cur) => (cur === 'EUR'
  ? n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
  : `${n.toLocaleString('fr-FR')} FCFA`);

function show(el, text) {
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

function el(tag, props, ...children) {
  const node = Object.assign(document.createElement(tag), props || {});
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

let adminToken = '';
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
  const res = await fetch(path, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || 'Erreur réseau');
    err.status = res.status;
    throw err;
  }
  return body;
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = 'Copié ✓';
    setTimeout(() => { button.textContent = old; }, 1500);
  } catch {
    window.prompt('Copiez :', text);
  }
}

const ACCOUNT_LABEL = {
  airtel: ['Numéro Airtel Money', 'tel', '077 12 34 56'],
  paypal: ['E-mail du compte PayPal', 'email', 'nom@exemple.fr'],
  wero: ['Mobile français ou e-mail Wero', 'text', '06 12 34 56 78'],
  sepa: ['IBAN du bénéficiaire', 'text', 'FR76 3000 6000 0112 3456 7890 189'],
};

// ---------- Page de demande ----------
function initSend() {
  const state = { direction: 'fr_to_ga', pay: null, payout: null, methods: null, fees: null, amounts: { fr_to_ga: 100, ga_to_fr: 65000 } };

  function chips(container, list, key) {
    container.replaceChildren(...list.map((m) => {
      const b = el('button', { type: 'button', className: 'chip', disabled: !m.available }, m.label);
      b.setAttribute('aria-pressed', String(state[key] === m.id));
      if (m.surcharge && m.available) b.append(el('small', {}, `+${state.fees.paypalSurchargePercent} %`));
      if (!m.available) b.append(el('small', {}, 'Indisponible'));
      b.addEventListener('click', () => { state[key] = m.id; render(); });
      return b;
    }));
  }

  function render() {
    const m = state.methods[state.direction];
    const pick = (list, cur) => (list.some((x) => x.id === cur && x.available) ? cur : (list.find((x) => x.available) || list[0]).id);
    state.pay = pick(m.pay, state.pay);
    state.payout = pick(m.payout, state.payout);
    for (const t of document.querySelectorAll('[data-dir]')) t.setAttribute('aria-selected', String(t.dataset.dir === state.direction));
    const fr = state.direction === 'fr_to_ga';
    $('sendCur').textContent = fr ? 'EUR' : 'FCFA';
    $('recvCur').textContent = fr ? 'FCFA' : 'EUR';
    $('amount').step = fr ? '1' : '500';
    chips($('payChips'), m.pay, 'pay');
    chips($('payoutChips'), m.payout, 'payout');
    const [label, type, placeholder] = ACCOUNT_LABEL[state.payout];
    $('accountLabel').textContent = label;
    $('recipientAccount').type = type;
    $('recipientAccount').placeholder = placeholder;
    refresh();
  }

  let timer;
  async function refresh() {
    const qs = new URLSearchParams({ direction: state.direction, amount: $('amount').value, pay: state.pay, payout: state.payout });
    try {
      const q = await api(`/api/quote?${qs}`);
      const cur = q.sendCurrency;
      $('received').textContent = q.receiveAmount.toLocaleString('fr-FR', { minimumFractionDigits: cur === 'XAF' ? 2 : 0 });
      $('fee').textContent = money(q.fee, cur);
      $('discount').textContent = q.firstTransferDiscount ? `− ${money(q.firstTransferDiscount, cur)}` : '—';
      $('total').textContent = money(q.total, cur);
      show($('quoteError'), '');
      $('compare').replaceChildren(...q.comparison.map((c, i) => el('tr', { className: i === 0 ? 'best' : '' },
        el('td', {}, c.name), el('td', {}, money(c.cost, cur)), el('td', {}, money(c.receive, q.receiveCurrency)))));
    } catch (err) {
      for (const id of ['received', 'fee', 'discount', 'total']) $(id).textContent = '—';
      $('compare').replaceChildren();
      show($('quoteError'), err.message);
    }
  }

  for (const t of document.querySelectorAll('[data-dir]')) {
    t.addEventListener('click', () => {
      state.amounts[state.direction] = $('amount').value;
      state.direction = t.dataset.dir;
      $('amount').value = state.amounts[state.direction];
      $('recipientAccount').value = '';
      render();
    });
  }
  $('amount').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 250); });

  api('/api/config').then((c) => {
    state.methods = c.methods;
    state.fees = c.fees;
    $('promoText').textContent = `Jusqu’à ${money(c.fees.firstTransferFreeMaxEur, 'EUR')} offerts. Ensuite ${money(c.fees.smallFeeEur, 'EUR')} jusqu’à ${c.fees.smallLimitEur} €.`;
    render();
  }).catch((err) => show($('quoteError'), err.message));

  $('sendForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!$('confirm').checked) return show($('formError'), 'Cochez la case pour confirmer les coordonnées du bénéficiaire.');
    $('submit').disabled = true;
    show($('formError'), '');
    try {
      const r = await api('/api/requests', {
        method: 'POST',
        body: JSON.stringify({
          direction: state.direction,
          payMethod: state.pay,
          payoutMethod: state.payout,
          amount: Number($('amount').value),
          recipientAccount: $('recipientAccount').value,
          recipientName: $('recipientName').value,
          senderName: $('senderName').value,
          senderContact: $('senderContact').value,
        }),
      });
      location.href = r.trackUrl;
    } catch (err) {
      show($('formError'), err.message);
      $('submit').disabled = false;
    }
  });
}

// ---------- Page de suivi ----------
const PAYOUT = { airtel: 'Airtel Money', paypal: 'PayPal', wero: 'Wero', sepa: 'compte bancaire' };
const STATUS = {
  awaiting_payment: ['À payer : suivez les instructions ci-dessous', 'pending'],
  declared: ['Paiement annoncé : l’organisateur vérifie la réception', 'pending'],
  paid: ['Paiement reçu : envoi en cours', 'pending'],
  completed: ['Argent envoyé ✓', 'ok'],
  cancelled: ['Demande annulée', 'bad'],
  refunded: ['Vous avez été remboursé', 'bad'],
};

function initTrack() {
  const p = new URLSearchParams(location.search);
  const id = encodeURIComponent(p.get('id') || '');
  const tok = encodeURIComponent(p.get('t') || '');

  function paint(r) {
    $('code').textContent = r.code;
    const [label, kind] = STATUS[r.status] || [r.status, 'pending'];
    $('status').textContent = r.status === 'completed' ? `Argent envoyé sur ${PAYOUT[r.payoutMethod]} ✓` : label;
    $('status').className = `status ${kind}`;

    const ins = r.instructions;
    $('payBox').classList.toggle('hidden', !ins);
    if (ins) {
      $('payTitle').textContent = `Payer par ${ins.method}`;
      $('payAmount').textContent = ins.amount;
      $('payTo').textContent = ins.to + (ins.name ? ` (${ins.name})` : '');
      $('copyTo').onclick = () => copy(ins.to.replace(/\s/g, ''), $('copyTo'));
      $('paySteps').replaceChildren(...ins.steps.map((s) => el('li', {}, s)));
      $('payLink').classList.toggle('hidden', !ins.link);
      if (ins.link) $('payLink').href = ins.link;
      $('declareBox').classList.toggle('hidden', r.status !== 'awaiting_payment');
    }

    const rows = [
      ['Bénéficiaire', `${r.recipientName} (${PAYOUT[r.payoutMethod]} ${r.recipientAccount})`],
      ['Montant reçu', money(r.receiveAmount, r.receiveCurrency)],
      ['Montant envoyé', money(r.sendAmount, r.sendCurrency)],
      ['Frais', money(r.fee, r.sendCurrency)],
    ];
    if (r.discount) rows.push(['Premier envoi offert', `− ${money(r.discount, r.sendCurrency)}`]);
    rows.push(['Total à payer', money(r.total, r.sendCurrency)]);
    if (r.payoutRef) rows.push(['Référence de l’envoi', r.payoutRef]);
    if (r.note) rows.push(['Motif', r.note]);
    $('details').replaceChildren(...rows.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v))));
    if (r.operatorWhatsapp) show($('whatsapp'), `Une question ? Contactez l’organisateur sur WhatsApp : ${r.operatorWhatsapp}`);
    return kind === 'pending';
  }

  let timer;
  async function load() {
    clearTimeout(timer);
    try {
      if (paint(await api(`/api/requests/${id}?t=${tok}`))) timer = setTimeout(load, 8000);
    } catch (err) {
      $('status').textContent = err.message;
      $('status').className = 'status bad';
    }
  }

  async function act(path, body) {
    show($('actionError'), '');
    try {
      paint(await api(path, { method: 'POST', body: JSON.stringify(body || {}) }));
      timer = setTimeout(load, 8000);
    } catch (err) {
      show($('actionError'), err.message);
    }
  }
  $('declare').addEventListener('click', () => act(`/api/requests/${id}/paid?t=${tok}`, { payerRef: $('payerRef').value }));
  $('cancel').addEventListener('click', () => act(`/api/requests/${id}/cancel?t=${tok}`));
  load();
}

// ---------- Espace organisateur ----------
const STATUS_ADMIN = {
  awaiting_payment: 'Pas encore payé', declared: 'Paiement annoncé', paid: 'Payé, à envoyer',
  completed: 'Envoyé', cancelled: 'Annulée', refunded: 'Remboursée',
};

function initAdmin() {
  const KEY = 'envoigabon-organisateur';
  try { adminToken = sessionStorage.getItem(KEY) || ''; } catch { /* stockage indisponible */ }

  function copyLine(label, value) {
    const b = el('button', { type: 'button', className: 'secondary small' }, 'Copier');
    b.addEventListener('click', () => copy(value, b));
    return el('div', { className: 'line' }, el('span', {}, label), el('strong', {}, value), b);
  }

  function card(r) {
    const pay = money(r.total, r.send_currency);
    const give = money(r.receive_amount, r.receive_currency);
    const rawAmount = r.receive_currency === 'EUR' ? r.receive_amount.toFixed(2).replace('.', ',') : String(r.receive_amount);
    const box = el('div', { className: 'todo-box' },
      el('div', {}, `1. Vérifier que vous avez reçu ${pay} par ${r.pay_method === 'virement' ? 'virement' : PAYOUT[r.pay_method] || r.pay_method}` +
        (r.payer_ref ? ` (réf. annoncée : ${r.payer_ref})` : '') + ` de ${r.sender_name}.`),
      el('div', {}, `2. Envoyer ${give} par ${PAYOUT[r.payout_method]} :`),
      copyLine('À :', r.account_display),
      copyLine('Montant :', rawAmount),
      copyLine('Motif :', r.code),
      r.payout_method === 'paypal'
        ? el('a', { href: 'https://www.paypal.com/myaccount/transfer/homepage/pay', target: '_blank', rel: 'noopener' }, 'Ouvrir PayPal')
        : null,
    );

    const ref = el('input', { placeholder: 'Référence de votre envoi (facultatif)', maxLength: 80 });
    const actions = el('div', { className: 'actions' });
    const act = (action, label, primary) => {
      const b = el('button', { type: 'button', className: primary ? 'secondary go' : 'secondary' }, label);
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await api(`/api/admin/requests/${r.id}/${action}`, { method: 'POST', body: JSON.stringify({ ref: ref.value }) });
          await load();
        } catch (err) {
          show($('adminError'), err.message);
          b.disabled = false;
        }
      });
      actions.append(b);
    };
    if (['awaiting_payment', 'declared'].includes(r.status)) {
      act('received', 'Paiement reçu ✓', true);
      act('cancel', 'Pas reçu : annuler');
    }
    if (r.status === 'paid') {
      act('sent', 'Argent envoyé ✓', true);
      act('refunded', 'J’ai remboursé');
    }

    const todo = ['awaiting_payment', 'declared', 'paid'].includes(r.status);
    return el('article', { className: 'req' },
      el('header', {},
        el('h3', {}, `${r.code} · ${r.direction === 'fr_to_ga' ? 'France → Gabon' : 'Gabon → France'}`),
        el('span', { className: `pill ${r.status === 'completed' ? 'ok' : todo ? 'pending' : 'bad'}` }, STATUS_ADMIN[r.status])),
      el('div', {}, `${r.sender_name} (${r.sender_contact}) paie ${pay} → ${r.recipient_name} reçoit ${give}`),
      el('small', {}, `Frais : ${money(r.fee, r.send_currency)} · ${new Date(r.created_at).toLocaleString('fr-FR')}` +
        (r.payout_ref ? ` · réf. envoi ${r.payout_ref}` : '') + (r.note ? ` · ${r.note}` : '')),
      todo ? box : null,
      r.status === 'paid' ? ref : null,
      actions.children.length ? actions : null,
    );
  }

  async function load() {
    show($('adminError'), '');
    const f = $('filter').value;
    try {
      let list = await api(`/api/admin/requests${f && f !== 'todo' ? `?status=${f}` : ''}`);
      if (f === 'todo') list = list.filter((r) => ['declared', 'paid', 'awaiting_payment'].includes(r.status));
      // Les paiements annoncés et payés d'abord.
      const order = { declared: 0, paid: 1, awaiting_payment: 2 };
      list.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));
      $('list').replaceChildren(...(list.length ? list.map(card) : [el('p', { className: 'fine' }, 'Rien à traiter pour le moment.')]));
    } catch (err) {
      if (err.status === 401) return logout();
      show($('adminError'), err.message);
    }
  }

  function enter() {
    $('tokenForm').classList.add('hidden');
    $('adminView').classList.remove('hidden');
    $('adminLogout').classList.remove('hidden');
    load();
  }
  function logout() {
    adminToken = '';
    try { sessionStorage.removeItem(KEY); } catch { /* rien */ }
    $('tokenForm').classList.remove('hidden');
    $('adminView').classList.add('hidden');
    $('adminLogout').classList.add('hidden');
  }

  $('tokenForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    adminToken = $('token').value.trim();
    try {
      await api('/api/admin/requests?status=declared');
      try { sessionStorage.setItem(KEY, adminToken); } catch { /* rien */ }
      enter();
    } catch (err) {
      adminToken = '';
      show($('tokenError'), err.message);
    }
  });
  $('adminLogout').addEventListener('click', logout);
  $('filter').addEventListener('change', load);
  $('reload').addEventListener('click', load);
  setInterval(() => { if (adminToken) load(); }, 30_000);
  if (adminToken) enter();
}

({ send: initSend, track: initTrack, admin: initAdmin })[document.body.dataset.page]();
