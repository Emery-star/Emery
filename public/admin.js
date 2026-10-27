'use strict';

const $ = (id) => document.getElementById(id);
const KEY = 'envoigabon-admin';
let token = '';
try { token = sessionStorage.getItem(KEY) || ''; } catch { /* stockage indisponible */ }

const money = (n, cur) => (cur === 'EUR'
  ? n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
  : `${n.toLocaleString('fr-FR')} FCFA`);

function show(el, text) {
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) logout();
  if (!res.ok) throw new Error(body.error || 'Erreur réseau');
  return body;
}

function cell(...children) {
  const td = document.createElement('td');
  td.append(...children);
  return td;
}

function button(label, onClick, confirmText) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'secondary';
  b.textContent = label;
  // Double clic de confirmation pour les actions sur l'argent (les boîtes confirm() peuvent être bloquées).
  b.addEventListener('click', async () => {
    if (confirmText && b.dataset.armed !== '1') {
      b.dataset.armed = '1';
      b.textContent = confirmText;
      setTimeout(() => { b.dataset.armed = ''; b.textContent = label; }, 4000);
      return;
    }
    b.disabled = true;
    try { await onClick(); } finally { b.disabled = false; }
  });
  return b;
}

const DIR = { fr_to_ga: 'FR → GA', ga_to_fr: 'GA → FR' };

async function loadTransfers() {
  show($('tError'), '');
  try {
    const list = await api(`/api/admin/transfers?status=${encodeURIComponent($('tStatus').value)}`);
    $('tBody').replaceChildren(...list.map((t) => {
      const tr = document.createElement('tr');
      const actions = document.createElement('div');
      actions.className = 'actions';
      const act = (path, body) => async () => {
        try {
          await api(path, { method: 'POST', body: JSON.stringify(body || {}) });
          await loadTransfers();
        } catch (err) { show($('tError'), err.message); }
      };
      if (['awaiting_payment', 'sending', 'paid'].includes(t.status)) {
        actions.append(button('Revérifier', act(`/api/admin/transfers/${t.id}/recheck`)));
      }
      if (t.status === 'needs_review') {
        actions.append(button('Revérifier', act(`/api/admin/transfers/${t.id}/recheck`)));
        if (t.payment_ref) {
          actions.append(button('Versé ✓', act(`/api/admin/transfers/${t.id}/resolve`, { outcome: 'completed' }), 'Confirmer : versé ?'));
          actions.append(button('Rembourser', act(`/api/admin/transfers/${t.id}/resolve`, { outcome: 'refund' }), 'Confirmer le remboursement ?'));
        } else {
          actions.append(button('Annuler', act(`/api/admin/transfers/${t.id}/resolve`, { outcome: 'cancel' }), 'Confirmer l’annulation ?'));
        }
      }
      const reason = t.failure_reason ? `\n${t.failure_reason}` : '';
      tr.append(
        cell(new Date(t.created_at).toLocaleString('fr-FR')),
        cell(t.status + reason),
        cell(`${DIR[t.direction]}\n${t.pay_method} → ${t.payout_method}`),
        cell(`${t.sender_name}\n${t.sender_contact}`),
        cell(`${t.recipient_name}\n${t.recipient_account}`),
        cell(money(t.total, t.send_currency)),
        cell(money(t.receive_amount, t.receive_currency)),
        cell(actions),
      );
      for (const td of tr.children) td.className = 'pre';
      return tr;
    }));
  } catch (err) {
    show($('tError'), err.message);
  }
}

async function loadUsers() {
  show($('uError'), '');
  try {
    const list = await api(`/api/admin/users?kyc=${encodeURIComponent($('uKyc').value)}`);
    $('uBody').replaceChildren(...list.map((u) => {
      const tr = document.createElement('tr');
      const actions = document.createElement('div');
      actions.className = 'actions';
      const decide = (decision) => async () => {
        try {
          await api(`/api/admin/users/${u.id}/kyc`, {
            method: 'POST',
            body: JSON.stringify({ decision, reason: decision === 'rejected' ? 'Pièce d’identité non conforme' : null }),
          });
          await loadUsers();
        } catch (err) { show($('uError'), err.message); }
      };
      if (u.kycStatus === 'pending') {
        actions.append(button('Valider', decide('approved'), 'Confirmer la validation ?'));
        actions.append(button('Refuser', decide('rejected'), 'Confirmer le refus ?'));
      }
      tr.append(
        cell(new Date(u.createdAt).toLocaleDateString('fr-FR')),
        cell(u.fullName),
        cell(u.email),
        cell(u.birthDate || '—'),
        cell(u.country || '—'),
        cell(u.idType ? `${u.idType} ${u.idNumber}` : '—'),
        cell(u.kycStatus + (u.kycReason ? ` (${u.kycReason})` : '')),
        cell(actions),
      );
      return tr;
    }));
  } catch (err) {
    show($('uError'), err.message);
  }
}

function enter() {
  $('tokenForm').classList.add('hidden');
  $('adminView').classList.remove('hidden');
  $('adminLogout').classList.remove('hidden');
  loadTransfers();
  loadUsers();
}

function logout() {
  token = '';
  try { sessionStorage.removeItem(KEY); } catch { /* rien */ }
  $('tokenForm').classList.remove('hidden');
  $('adminView').classList.add('hidden');
  $('adminLogout').classList.add('hidden');
}

$('tokenForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  token = $('token').value.trim();
  try {
    await api('/api/admin/users?kyc=pending');
    try { sessionStorage.setItem(KEY, token); } catch { /* rien */ }
    enter();
  } catch (err) {
    show($('tokenError'), err.message);
  }
});
$('adminLogout').addEventListener('click', logout);
$('tStatus').addEventListener('change', loadTransfers);
$('uKyc').addEventListener('change', loadUsers);
$('tReload').addEventListener('click', loadTransfers);
$('uReload').addEventListener('click', loadUsers);
if (token) enter();
