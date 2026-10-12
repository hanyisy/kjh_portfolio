/*
 * 관리자 저장 담당 서버 함수 (Vercel)
 * ============================================================================
 * 브라우저에서 깃허브로 바로 쓰지 않고 이 함수를 거칩니다. 그래야 깃허브 토큰과
 * 관리자 비밀번호가 브라우저로 내려가지 않습니다. 둘 다 Vercel 환경변수에만 둡니다.
 *
 * 필요한 환경변수 (Vercel 프로젝트 설정 → Environment Variables)
 *   ADMIN_PASSWORD  관리자 페이지 비밀번호
 *   GITHUB_TOKEN    이 저장소 하나에만 Contents 쓰기 권한을 준 fine-grained 토큰
 *   GITHUB_REPO     hanyisy/kjh_portfolio
 *   GITHUB_BRANCH   main  (안 적으면 main)
 *
 * 하는 일
 *   check   비밀번호가 맞는지만 확인
 *   save    data/site.json 을 통째로 새로 커밋
 *   upload  이미지·PDF 한 개를 assets/ 아래에 커밋
 *   list    폴더 안 파일 목록 (관리자의 '폴더 확인' 도우미용)
 * ============================================================================
 */

const API = 'https://api.github.com';

/* 쓰기를 허용하는 곳. 이 두 가지 말고는 어디에도 못 씁니다.
   비밀번호가 새더라도 .github/workflows 같은 '실행되는 파일'은 건드릴 수 없게 합니다. */
const WRITABLE = [
  path => path === 'data/site.json',
  path => /^assets\/[A-Za-z0-9._\-\/]+$/.test(path) && !path.includes('..')
];

const ok = (res, body) => res.status(200).json({ ok: true, ...body });
const fail = (res, code, message) => res.status(code).json({ ok: false, error: message });

/* 비밀번호 비교. 길이가 다르면 바로 거르고, 같으면 끝까지 다 비교해
   맞은 글자 수로 답이 새지 않게 합니다. */
function samePassword(input, real) {
  if (typeof input !== 'string' || typeof real !== 'string') return false;
  if (input.length !== real.length) return false;
  let diff = 0;
  for (let i = 0; i < input.length; i++) diff |= input.charCodeAt(i) ^ real.charCodeAt(i);
  return diff === 0;
}

function settings() {
  const password = process.env.ADMIN_PASSWORD;
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const missing = [
    !password && 'ADMIN_PASSWORD',
    !token && 'GITHUB_TOKEN',
    !repo && 'GITHUB_REPO'
  ].filter(Boolean);
  return { password, token, repo, branch, missing };
}

async function github(conf, path, options = {}) {
  const response = await fetch(`${API}/repos/${conf.repo}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${conf.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'kjh-portfolio-admin',
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: response.status, body };
}

/* 같은 파일을 다시 쓰려면 지금 파일의 sha 를 함께 보내야 합니다.
   없으면(새 파일) sha 없이 보냅니다. */
async function currentSha(conf, path) {
  const got = await github(conf, `contents/${encodeURI(path)}?ref=${encodeURIComponent(conf.branch)}`);
  if (got.status === 200 && got.body && !Array.isArray(got.body)) return got.body.sha;
  return null;
}

async function commitFile(conf, path, base64, message) {
  const sha = await currentSha(conf, path);
  const put = await github(conf, `contents/${encodeURI(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: base64, branch: conf.branch, ...(sha ? { sha } : {}) })
  });
  if (put.status !== 200 && put.status !== 201) {
    const reason = (put.body && put.body.message) || `HTTP ${put.status}`;
    throw new Error(`깃허브에 쓰지 못했습니다: ${reason}`);
  }
  return { path, commit: put.body && put.body.commit && put.body.commit.sha, created: put.status === 201 };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'POST 로만 받습니다');

  const conf = settings();
  if (conf.missing.length) {
    return fail(res, 500, `서버에 환경변수가 없습니다: ${conf.missing.join(', ')}`);
  }

  const payload = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  if (!payload) return fail(res, 400, '내용을 읽지 못했습니다');

  if (!samePassword(payload.password, conf.password)) {
    return fail(res, 401, '비밀번호가 맞지 않습니다');
  }

  try {
    switch (payload.action) {
      case 'check':
        return ok(res, { repo: conf.repo, branch: conf.branch });

      case 'save': {
        if (!payload.data || typeof payload.data !== 'object') return fail(res, 400, '저장할 내용이 없습니다');
        const text = JSON.stringify(payload.data, null, 2) + '\n';
        const result = await commitFile(conf, 'data/site.json',
          Buffer.from(text, 'utf8').toString('base64'),
          payload.message || '관리자에서 내용 수정');
        return ok(res, result);
      }

      case 'upload': {
        const path = String(payload.path || '');
        if (!WRITABLE.some(allow => allow(path))) return fail(res, 400, `이 경로에는 올릴 수 없습니다: ${path}`);
        if (typeof payload.content !== 'string' || !payload.content) return fail(res, 400, '파일 내용이 없습니다');
        const result = await commitFile(conf, path, payload.content, `관리자에서 파일 올림: ${path}`);
        return ok(res, result);
      }

      case 'list': {
        const folder = String(payload.folder || 'assets/portfolio').replace(/^\/+|\/+$/g, '');
        if (!/^assets(\/[A-Za-z0-9._-]+)*$/.test(folder)) return fail(res, 400, '볼 수 없는 폴더입니다');
        const got = await github(conf, `contents/${encodeURI(folder)}?ref=${encodeURIComponent(conf.branch)}`);
        if (got.status !== 200 || !Array.isArray(got.body)) return fail(res, 404, '폴더를 찾지 못했습니다');
        return ok(res, {
          folder,
          files: got.body
            .filter(item => item.type === 'file')
            .map(item => ({ name: item.name, size: item.size }))
        });
      }

      default:
        return fail(res, 400, `모르는 요청입니다: ${payload.action}`);
    }
  } catch (error) {
    // 토큰이 메시지에 섞여 나가지 않도록 우리가 만든 문구만 내보냅니다.
    return fail(res, 502, error.message || '처리하지 못했습니다');
  }
};

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/* 테스트에서 안쪽 함수를 따로 불러 볼 수 있게 열어 둡니다. */
module.exports.internals = { samePassword, WRITABLE };
