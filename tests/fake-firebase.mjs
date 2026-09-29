// 테스트용 가짜 Firebase: 서버 코드(lib/server.js)를 실제 서비스 없이 돌려 보기 위한 메모리 데이터베이스
export function fakeFirestore() {
  const store = new Map(); // path -> data
  let auto = 0;
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const snap = (path, ref) => ({ id: path.split('/').pop(), exists: store.has(path), data: () => clone(store.get(path)), ref });
  function setDotted(obj, key, val) {
    const parts = key.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] && typeof o[parts[i]] === 'object' ? o[parts[i]] : {}; o = o[parts[i]]; }
    o[parts.at(-1)] = val;
  }
  function docRef(path) {
    const ref = {
      id: path.split('/').pop(), path,
      async get() { return snap(path, ref); },
      async set(data, opt) { const cur = opt?.merge ? store.get(path) || {} : {}; store.set(path, deepMerge(cur, clone(data))); },
      async update(patch) { if (!store.has(path)) throw Object.assign(new Error('no doc ' + path), { code: 'not-found' }); const cur = store.get(path); for (const [k, v] of Object.entries(clone(patch))) setDotted(cur, k, v); },
      async delete() { store.delete(path); },
    };
    return ref;
  }
  function deepMerge(a, b) {
    for (const [k, v] of Object.entries(b)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) a[k] = deepMerge(a[k], v);
      else a[k] = v;
    }
    return a;
  }
  function query(col, filters = []) {
    return {
      _q: true,
      where(f, op, v) { return query(col, [...filters, [f, op, v]]); },
      async get() {
        const docs = [];
        for (const [p, d] of store) {
          const parts = p.split('/');
          if (parts.length !== 2 || parts[0] !== col) continue;
          const ok = filters.every(([f, op, v]) => {
            const x = d[f];
            return op === '==' ? x === v : op === '<' ? x < v : op === '<=' ? x <= v : op === '>' ? x > v : op === 'in' ? v.includes(x) : false;
          });
          if (ok) docs.push(snap(p, docRef(p)));
        }
        return { docs, empty: !docs.length, size: docs.length, forEach: f => docs.forEach(f) };
      },
    };
  }
  const db = {
    store,
    reads: 0,
    doc: p => docRef(p),
    collection: col => Object.assign(query(col), {
      doc: id => docRef(col + '/' + (id || 'auto' + ++auto)),
      async add(data) { const r = docRef(col + '/auto' + ++auto); await r.set(data); return r; },
    }),
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: async r => { db.reads++; return r._q ? r.get() : r.get(); },
        set: (r, d, o) => writes.push(() => r.set(d, o)),
        update: (r, d) => writes.push(() => r.update(d)),
        delete: r => writes.push(() => r.delete()),
      };
      const out = await fn(tx);
      for (const w of writes) await w();
      return out;
    },
    bulkWriter() { const ops = []; return { delete: r => ops.push(r), close: async () => { for (const r of ops) await r.delete(); } }; },
  };
  return db;
}

export function fakeAuth() {
  const tokens = new Map(); // token -> decoded
  const claims = new Map();
  return {
    tokens, claims,
    login(token, decoded) { tokens.set(token, decoded); },
    async verifyIdToken(t) { const d = tokens.get(t); if (!d) throw new Error('bad token'); return { ...d, ...(claims.get(d.uid) || {}) }; },
    async setCustomUserClaims(uid, c) { claims.set(uid, c); },
  };
}

export function fakeMessaging() {
  const sent = [];
  return { sent, async send(m) { if (m.token === 'dead') throw { errorInfo: { code: 'messaging/registration-token-not-registered' } }; sent.push(m); return 'id'; } };
}
