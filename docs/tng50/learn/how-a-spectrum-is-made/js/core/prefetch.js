// Field prefetch (DESIGN_final C_eng P1-3). Each beat lists the volume fields it needs (beats.json fields) and a lead in
// p; a field is requested once p ≥ beat.p0 − lead, so it is resident before the beat starts at any normal scroll speed.
// The planner is pure; the prefetcher remembers what it already asked for and calls the stage's loader once per field.
//
//   prefetchPlan(beats, p) -> [{name, level, beat, due}]   fields wanted at p, current beat first, then by due p
//   createPrefetcher({beats, load}) -> {update(p) -> newly issued [{key, name, level, p, beat}], issued: Map, reset()}
//     load(name, level) may return a promise; a rejected load is forgotten so a later update() retries it.

export const fieldKey = f => `${f.name}@${f.level}`;

export function prefetchPlan(beats, p) {
  const out = [], seen = new Set();
  const add = (f, b, due) => { const k = fieldKey(f); if (!seen.has(k)) { seen.add(k); out.push({name: f.name, level: f.level, beat: b.id, due}); } };
  let cur = beats.findIndex(b => p >= b.p0 && p < b.p1);
  if (cur < 0) cur = p >= 1 ? beats.length - 1 : 0;
  beats[cur].fields.forEach(f => add(f, beats[cur], beats[cur].p0));
  const later = [];
  for (let j = cur + 1; j < beats.length; j++) { const b = beats[j]; if (p >= b.p0 - (b.lead || 0)) later.push(b); }
  later.sort((a, c) => a.p0 - c.p0).forEach(b => b.fields.forEach(f => add(f, b, b.p0)));
  return out;
}

export function createPrefetcher({beats, load}) {
  const issued = new Map();
  return {
    issued,
    update(p) {
      const fresh = [];
      for (const it of prefetchPlan(beats, p)) {
        const k = fieldKey(it);
        if (issued.has(k)) continue;
        issued.set(k, p);
        fresh.push({key: k, name: it.name, level: it.level, p, beat: it.beat});
        try {
          const r = load ? load(it.name, it.level) : null;
          if (r && typeof r.then === "function") r.then(null, () => issued.delete(k));
        } catch { issued.delete(k); }
      }
      return fresh;
    },
    reset() { issued.clear(); },
  };
}
