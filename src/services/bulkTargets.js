/**
 * Recipients in Fonnte-compatible syntax: comma-separated entries (or an array), each
 * "number|name|var1|var2|…". The values feed {name}, {var1}, {var2}, … in the message.
 */
export function parseTargets(to) {
  const entries = Array.isArray(to) ? to : String(to ?? '').split(',');
  return entries
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean)
    .map((entry) => {
      const [number, name = '', ...vars] = entry.split('|').map((part) => part.trim());
      return { number, name, vars };
    });
}

/**
 * Replaces {name} and {var1}…{varN} with the target's values; missing values become empty.
 */
export function renderTemplate(text, { name = '', vars = [] }) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{(name|var(\d+))\}/g, (match, key, index) => (key === 'name' ? name : vars[Number(index) - 1] ?? ''));
}

/**
 * True when `to` addresses several recipients or carries template values.
 */
export function isBulkTarget(to) {
  if (Array.isArray(to)) return to.length !== 1 || String(to[0]).includes('|');
  return typeof to === 'string' && (to.includes(',') || to.includes('|'));
}
