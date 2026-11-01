// Placement rules: which workers a kind of job prefers, in order, so callers need not know worker IDs.

const MATCH_KEYS = ['type', 'kind', 'class', 'requires'];
const RULE_KEYS = ['match', 'workers', 'others'];

/**
 * Checks the `placement` list of the config. Rules are tried in order and the first whose `match` fits wins.
 * A rule: `{ match: { type?, kind?, class?, requires? }, workers: [ids], others?: boolean }`.
 * @returns {{ match: object, workers: string[], others: boolean }[]}
 */
export function normalizePlacement(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('placement must be a list of rules');
  return raw.map((rule, i) => {
    const where = `placement[${i}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`${where} must be a mapping`);
    for (const k of Object.keys(rule)) if (!RULE_KEYS.includes(k)) throw new Error(`${where}: unknown setting "${k}" (known: ${RULE_KEYS.join(', ')})`);
    const match = rule.match ?? {};
    if (typeof match !== 'object' || Array.isArray(match)) throw new Error(`${where}.match must be a mapping`);
    for (const k of Object.keys(match)) if (!MATCH_KEYS.includes(k)) throw new Error(`${where}.match: unknown setting "${k}" (known: ${MATCH_KEYS.join(', ')})`);
    const requires = match.requires === undefined ? undefined : [].concat(match.requires).map(String);
    for (const k of ['type', 'kind', 'class']) {
      if (match[k] !== undefined && typeof match[k] !== 'string') throw new Error(`${where}.match.${k} must be a string`);
    }
    const workers = rule.workers;
    if (!Array.isArray(workers) || !workers.length || workers.some(w => typeof w !== 'string' || !w.trim()) || new Set(workers).size !== workers.length) {
      throw new Error(`${where}.workers must be a non-empty list of unique worker IDs, most preferred first`);
    }
    if (rule.others !== undefined && typeof rule.others !== 'boolean') throw new Error(`${where}.others must be true or false`);
    return { match: { ...match, ...(requires ? { requires } : {}) }, workers: [...workers], others: rule.others ?? false };
  });
}

/** True if a job spec fits a rule's `match` (an empty match fits every job). */
export function ruleMatches(rule, spec) {
  const m = rule.match;
  if (m.type !== undefined && m.type !== spec.type) return false;
  if (m.kind !== undefined && m.kind !== spec.kind) return false;
  if (m.class !== undefined && m.class !== spec.class) return false;
  if (m.requires && !m.requires.every(r => (spec.requires ?? []).includes(r))) return false;
  return true;
}

/**
 * The worker order for a job: its own `workerPreference` (a strict allowlist) wins over the config rules.
 * @returns {{ workers: string[], others: boolean } | null}  null = no preference, least-loaded placement.
 */
export function preferenceFor(rules, spec) {
  if (spec.workerPreference) return { workers: spec.workerPreference, others: false };
  const rule = rules.find(r => ruleMatches(r, spec));
  return rule ? { workers: rule.workers, others: rule.others } : null;
}
