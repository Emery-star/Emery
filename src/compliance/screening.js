'use strict';

const fs = require('node:fs');

/** Met un nom sous une forme comparable : sans accents, minuscules, mots triés. */
function normalizeName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z\s]/g, ' ')
    .split(/\s+/).filter(Boolean).sort().join(' ');
}

/**
 * Filtrage des personnes sur des listes de sanctions (gel des avoirs).
 *
 * Le fichier JSON contient : [{ "name": "...", "birthDate": "AAAA-MM-JJ" (facultatif), "list": "..." }].
 * En production, alimentez-le depuis les listes officielles (registre national des gels de la DG Trésor,
 * liste consolidée de l'UE, ONU) et mettez-le à jour chaque jour, ou remplacez ce module par un prestataire
 * de filtrage. La correspondance est volontairement stricte (mêmes mots, dans n'importe quel ordre) :
 * un prestataire ajoutera la recherche approchée.
 */
function createScreening(file) {
  let entries = [];
  if (file && fs.existsSync(file)) {
    entries = JSON.parse(fs.readFileSync(file, 'utf8')).map((e) => ({ ...e, key: normalizeName(e.name) }));
  }
  return {
    size: entries.length,
    check({ name, birthDate }) {
      const key = normalizeName(name);
      const hit = entries.find((e) => e.key === key && (!e.birthDate || !birthDate || e.birthDate === birthDate));
      return hit ? { listName: hit.list || 'liste de sanctions', name: hit.name } : null;
    },
  };
}

module.exports = { createScreening, normalizeName };
