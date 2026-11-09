const { httpError, safeEqual, verifyToken } = require('./util.cjs');

// Vercel 서버리스 함수 공통 처리: 액션 분기, 접속코드·관리자 확인, 오류 응답
module.exports = function route(handlers, { open = [], admin = false, adminOpen = [] } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const query = req.query || {};
      const key = `${req.method} ${query.action || ''}`;
      const fn = handlers[key];
      if (!fn) throw httpError(404, '지원하지 않는 요청입니다.');

      const code = process.env.ROOM_ACCESS_CODE; // 회의실 접속 코드(줄안서 접수 코드와 같게 두면 한 번만 입력)
      if (code && !open.includes(key) && !safeEqual(req.headers['x-access-code'] || '', code))
        throw httpError(401, '접속 코드가 필요합니다.', { needAccess: true });

      let user = null;
      if (admin && !adminOpen.includes(key)) {
        const auth = String(req.headers.authorization || '');
        user = verifyToken(auth.startsWith('Bearer ') ? auth.slice(7) : '');
        if (!user) throw httpError(401, '관리자 로그인이 필요합니다.', { needLogin: true });
      }

      let body = req.body || {};
      if (typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch { throw httpError(400, '요청 형식이 올바르지 않습니다.'); }
      }
      const out = await fn({ req, res, query, body, user });
      if (res.headersSent || res.writableEnded) return;
      res.status(200).json(out ?? { ok: true });
    } catch (e) {
      const status = e.status || (e.code === '23P01' ? 409 : 500);
      if (status >= 500) console.error(e);
      res.status(status).json({ error: status >= 500 ? '서버 오류: ' + (e.message || '알 수 없는 오류') : e.message, ...(e.extra || {}) });
    }
  };
};
