'use strict';

const DAY = 86400_000;

/** Plafonds cumulés par client, en équivalent euros, sur 24 h et 30 jours glissants. */
function createLimits({ db, config }) {
  const sumSince = db.prepare(`SELECT COALESCE(SUM(amount_eur), 0) AS total FROM transfers
    WHERE user_id = ? AND created_at >= ? AND status IN ('awaiting_payment','paid','sending','completed','needs_review')`);

  return {
    check(userId, amountEur) {
      const { dailyEur, monthlyEur } = config.limits;
      const day = sumSince.get(userId, new Date(Date.now() - DAY).toISOString()).total;
      const month = sumSince.get(userId, new Date(Date.now() - 30 * DAY).toISOString()).total;
      if (day + amountEur > dailyEur) {
        return `Plafond de ${dailyEur} € par 24 h atteint (déjà ${day.toFixed(2)} €). Réessayez plus tard.`;
      }
      if (month + amountEur > monthlyEur) {
        return `Plafond de ${monthlyEur} € sur 30 jours atteint (déjà ${month.toFixed(2)} €).`;
      }
      return null;
    },
  };
}

module.exports = { createLimits };
