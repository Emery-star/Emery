'use strict';

/**
 * Alertes sur le téléphone de l'organisateur.
 * - ntfy : installer l'appli gratuite « ntfy » et s'abonner au sujet NTFY_TOPIC (choisir un nom long et
 *   impossible à deviner : tout le monde peut lire un sujet dont il connaît le nom).
 * - Telegram : créer un bot avec @BotFather, puis indiquer son jeton et votre identifiant de discussion.
 */
function createAlerts(cfg, { fetchImpl = fetch, logger = console } = {}) {
  const channels = [];

  if (cfg.ntfyTopic) {
    channels.push(({ title, text, url }) => fetchImpl(`${cfg.ntfyServer}/${encodeURIComponent(cfg.ntfyTopic)}`, {
      method: 'POST',
      // Les en-têtes HTTP n'acceptent que l'ASCII : titre sans accents.
      headers: { Title: title.normalize('NFD').replace(/[^\x20-\x7e]/g, ''), Tags: 'money_with_wings', ...(url ? { Click: url } : {}) },
      body: text,
    }));
  }

  if (cfg.telegramToken && cfg.telegramChatId) {
    channels.push(({ title, text, url }) => fetchImpl(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text: `${title}\n\n${text}${url ? `\n\n${url}` : ''}` }),
    }));
  }

  return {
    enabled: channels.length > 0,
    sent: [],
    /** N'échoue jamais : une alerte perdue ne doit pas bloquer une demande. */
    async send(message) {
      this.sent.push(message);
      if (!channels.length) {
        logger.log(`[alerte] ${message.title} — ${message.text.split('\n')[0]}`);
        return;
      }
      await Promise.all(channels.map(async (ch) => {
        try {
          const res = await ch(message);
          if (res && res.ok === false) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
          logger.error(`Alerte non envoyée : ${err.message}`);
        }
      }));
    },
  };
}

module.exports = { createAlerts };
