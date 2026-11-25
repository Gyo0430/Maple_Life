// 메할일 넥슨 API 중계 서버 (Vercel Serverless Function)
// - 넥슨 API 키는 Vercel 환경 변수 NEXON_API_KEY 에만 보관해요. 앱에는 들어가지 않아요.
// - 메할일에 로그인한 사용자(Supabase 토큰)만 호출할 수 있어요.
const NEXON = process.env.NEXON_BASE || 'https://open.api.nexon.com/maplestory/v1';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qagronrzscbgfzpbswuu.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_IWxRVfp9q-weerFrL9moaA_gdMI3Ejf';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const kstDate = (back = 0) => new Date(Date.now() + 9 * 3600e3 - back * 864e5).toISOString().slice(0, 10);
// 새벽(06시 이전)에 끝나는 이벤트는 그 전날을 마지막 날로 본다.
function endDay(iso) {
  const d = String(iso).slice(0, 10), h = +(String(iso).match(/T(\d{2})/) || [])[1];
  if (!(h < 6)) return d;
  const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10);
}

// 동시에 4개, 요청 사이 최소 120ms 간격으로 넥슨에 요청
function limiter(max = 4, gap = 120) {
  let active = 0, last = 0; const q = [];
  const next = async () => {
    if (active >= max || !q.length) return;
    active++; const { fn, res, rej } = q.shift();
    const wait = Math.max(0, last + gap - Date.now()); last = Date.now() + wait; if (wait) await sleep(wait);
    try { res(await fn()); } catch (e) { rej(e); } finally { active--; next(); }
  };
  return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 돼요' });
  const key = process.env.NEXON_API_KEY;
  if (!key) return res.status(500).json({ error: '서버에 넥슨 API 키가 설정되지 않았어요 (Vercel 환경 변수 NEXON_API_KEY)' });

  // 로그인 확인
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: '로그인이 필요해요' });
  try {
    const u = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SUPABASE_KEY, authorization: 'Bearer ' + token } });
    if (!u.ok) return res.status(401).json({ error: '로그인이 만료됐어요. 다시 로그인해 주세요.' });
  } catch (_) { return res.status(502).json({ error: '로그인 확인에 실패했어요' }); }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const chars = (Array.isArray(body && body.chars) ? body.chars : []).slice(0, 12)
    .map(c => ({ name: String(c && c.name || '').trim().slice(0, 20), days: Math.max(0, Math.min(30, Math.floor(+(c && c.days) || 0))) }))
    .filter(c => c.name);

  const lim = limiter();
  async function get(path, q) {
    const url = NEXON + path + '?' + new URLSearchParams(q);
    for (let i = 0; i < 4; i++) {
      const r = await lim(() => fetch(url, { headers: { 'x-nxopen-api-key': key } }));
      if (r.status === 429) { await sleep(1000 * (i + 1)); continue; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const code = (j.error && j.error.name) || String(r.status);
        const e = new Error(code + ' ' + ((j.error && j.error.message) || '')); e.code = code; throw e;
      }
      return j;
    }
    throw new Error('요청이 너무 많아요');
  }

  const out = { kind: 'meharil-import', v: 1, at: new Date().toISOString(), chars: [], failed: [] };
  let badKey = false;
  await Promise.all(chars.map(async c => {
    try {
      const { ocid } = await get('/id', { character_name: c.name });
      const [b, stat, union, sym] = await Promise.all([
        get('/character/basic', { ocid }),
        get('/character/stat', { ocid }).catch(() => null),
        get('/user/union', { ocid }).catch(() => null),
        get('/character/symbol-equipment', { ocid }).catch(() => null)
      ]);
      let image = '';
      if (b.character_image) {
        try {
          const r = await fetch(b.character_image);
          const type = (r.headers.get('content-type') || 'image/png').split(';')[0];
          const buf = Buffer.from(await r.arrayBuffer());
          if (r.ok && buf.length < 200000 && /^image\/(png|gif|jpeg|webp)$/.test(type)) image = `data:${type};base64,${buf.toString('base64')}`;
        } catch (_) {}
      }
      const hist = [{ date: kstDate(0), level: b.character_level, exp: +b.character_exp_rate || 0 }];
      const past = await Promise.all(Array.from({ length: c.days }, (_, i) => i + 1).map(d =>
        get('/character/basic', { ocid, date: kstDate(d) }).then(h => h.character_level ? { date: kstDate(d), level: h.character_level, exp: +h.character_exp_rate || 0 } : null).catch(() => null)));
      for (const p of past) if (p) hist.push(p);
      out.chars.push({
        name: b.character_name || c.name, world: b.world_name || '', job: b.character_class || '',
        level: b.character_level || 0, exp: +b.character_exp_rate || 0, guild: b.character_guild_name || '',
        power: String(((stat && stat.final_stat) || []).find(x => x.stat_name === '전투력')?.stat_value || ''),
        union: String((union && union.union_level) ?? ''), image,
        symbols: ((sym && sym.symbol) || []).map(x => ({ n: x.symbol_name || '', lv: +x.symbol_level || 0, f: +x.symbol_force || 0, g: +x.symbol_growth_count || 0, r: +x.symbol_require_growth_count || 0 })),
        hist
      });
    } catch (e) {
      if (e.code === 'OPENAPI00005') badKey = true;
      out.failed.push(c.name);
    }
  }));
  if (badKey) return res.status(500).json({ error: '서버의 넥슨 API 키가 올바르지 않아요' });

  if (body && body.events !== false) {
    try {
      const r = await get('/notice-event', {});
      out.events = (r.event_notice || []).filter(e => e.date_event_start && e.date_event_end).map(e => ({
        id: String(e.notice_id), title: e.title || '', url: e.url || '',
        start: String(e.date_event_start).slice(0, 10), end: endDay(e.date_event_end)
      }));
    } catch (_) {}
  }
  // 요청한 순서대로 정렬
  out.chars.sort((a, b) => chars.findIndex(c => c.name === a.name) - chars.findIndex(c => c.name === b.name));
  res.status(200).json(out);
};
