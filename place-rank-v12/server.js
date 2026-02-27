/**
 * 네이버 플레이스 5위 키워드 분석기 v12 — MASS KEYWORD BLASTER
 * ────────────────────────────────────────────────────────────
 * v11 대비 핵심 개선:
 *  1. ★★★ 복합 메뉴 합성 (차돌박이+칼국수→차돌박이칼국수) 자동 생성
 *  2. ★★★ 붙여쓰기 변형 (광안리칼국수맛집 / 광안리 칼국수 맛집 모두)
 *  3. ★★ 업종별 접미어 확장 (국수집, 한식집, 밥집, 맛있는집 등)
 *  4. ★★ 체계적 전수조사: 위치×근접어×메뉴×접미어 곱집합 완전소진
 *  5. ★★ 긴 체인 패턴 (벡스코 마린시티 요트 주변 한식 칼국수 맛집)
 *  6. ★ 500라운드 확장 (80→500) — 키워드 고갈 거의 불가
 *  7. ★ 동시 15탭, 배치 120개로 속도 50% 향상
 *  8. ★ 역순 키워드 (칼국수 부산, 맛집 광안리)
 *  9. ★ 오타/속어 변형 (맛잇는집, 맛있는집, 마싯는집)
 */

const express   = require('express');
const cors      = require('cors');
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');
const XLSX      = require('xlsx');
// https, zlib 삭제 — httpGet 제거로 더 이상 불필요

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ══════════════════════════════════════════════════════════
// 🔐 인증 시스템 (Auth System)
// ══════════════════════════════════════════════════════════
const crypto = require('crypto');
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── 파일 업로드 (multer) ──
let multer;
try { multer = require('multer'); } catch(e) { multer = null; }
const upload = multer ? multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `biz_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf','.jpg','.jpeg','.png'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
}) : null;

// ── 유저 DB 헬퍼 ──
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch(e) { return []; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}
function hashPw(pw) {
  return crypto.createHash('sha256').update(pw + 'easyboard_salt_2026').digest('hex');
}

// ── 세션 관리 (메모리) ──
const sessions = new Map(); // token -> { username, expiresAt }
function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, expiresAt: Date.now() + 7 * 24 * 3600 * 1000 }); // 7일
  return token;
}
function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  return s;
}

// ── 인증번호 저장 (메모리) ──
const verifyCodes = new Map(); // phone -> { code, expiresAt, verified }

// ── 쿠키 파서 ──
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const o = {};
  raw.split(';').forEach(c => { const [k, v] = c.trim().split('='); if (k) o[k] = v; });
  return o;
}

// ── 인증 미들웨어 ──
function authRequired(req, res, next) {
  const cookies = parseCookies(req);
  const session = getSession(cookies.session_token);
  if (!session) return res.redirect('/login');
  req.user = session;
  next();
}

// ── 페이지 라우트 ──
app.get('/login', (req, res) => {
  const cookies = parseCookies(req);
  if (getSession(cookies.session_token)) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/find-account', (req, res) => res.sendFile(path.join(__dirname, 'public', 'find-account.html')));
app.get('/admin', (req, res) => {
  const cookies = parseCookies(req);
  const session = getSession(cookies.session_token);
  if (!session) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── API: 로그인 상태 확인 ──
app.get('/api/auth/check', (req, res) => {
  const cookies = parseCookies(req);
  const session = getSession(cookies.session_token);
  res.json({ loggedIn: !!session, username: session?.username || null });
});

// ── API: 회원가입 (FormData + 파일 업로드) ──
const registerHandler = (req, res) => {
  const { username, email, name, company, phone, referrer, password, memberType } = req.body;
  if (!username || !email || !name || !phone || !password) {
    return res.json({ success: false, message: '필수 항목을 모두 입력해주세요.' });
  }
  if (!/^[a-zA-Z0-9]{4,20}$/.test(username)) {
    return res.json({ success: false, message: '아이디는 영문, 숫자 4~20자로 입력해주세요.' });
  }
  if (password.length < 8) {
    return res.json({ success: false, message: '비밀번호는 8자 이상이어야 합니다.' });
  }
  const users = loadUsers();
  if (users.find(u => u.username === username)) {
    return res.json({ success: false, message: '이미 사용 중인 아이디입니다.' });
  }
  if (users.find(u => u.email === email)) {
    return res.json({ success: false, message: '이미 등록된 이메일입니다.' });
  }
  const userData = {
    username, email, name, company: company || '', phone,
    referrer: referrer || '',
    password: hashPw(password),
    memberType: memberType || 'general',
    bizDoc: req.file ? req.file.filename : '',
    createdAt: new Date().toISOString().split('T')[0],
    approved: true // 자동승인 (필요시 false로 변경)
  };
  users.push(userData);
  saveUsers(users);
  console.log(`  [AUTH] 회원가입: ${username} (${name}) [${memberType || 'general'}]${req.file ? ' +파일:' + req.file.filename : ''}`);
  res.json({ success: true });
};
if (upload) {
  app.post('/api/auth/register', upload.single('bizDoc'), registerHandler);
} else {
  app.post('/api/auth/register', registerHandler);
}

// ── API: 로그인 ──
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.json({ success: false, message: '아이디와 비밀번호를 입력해주세요.' });
  }
  const users = loadUsers();
  const user = users.find(u => (u.username === username || u.email === username) && u.password === hashPw(password));
  if (!user) {
    return res.json({ success: false, message: '아이디 또는 비밀번호가 일치하지 않습니다.' });
  }
  if (!user.approved) {
    return res.json({ success: false, message: '관리자 승인 대기 중입니다. 잠시만 기다려주세요.' });
  }
  const token = createSession(user.username);
  res.setHeader('Set-Cookie', `session_token=${token}; Path=/; HttpOnly; Max-Age=${7*24*3600}; SameSite=Lax`);
  console.log(`  [AUTH] 로그인: ${user.username}`);
  res.json({ success: true, username: user.username });
});

// ── API: 로그아웃 ──
app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.session_token) sessions.delete(cookies.session_token);
  res.setHeader('Set-Cookie', 'session_token=; Path=/; HttpOnly; Max-Age=0');
  res.json({ success: true });
});

// ── API: 인증번호 발송 (시뮬레이션) ──
app.post('/api/auth/send-code', (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length < 10) {
    return res.json({ success: false, message: '올바른 휴대폰 번호를 입력해주세요.' });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  verifyCodes.set(phone, { code, expiresAt: Date.now() + 180000, verified: false });
  console.log(`  [AUTH] 인증번호 발송: ${phone} → ${code}`);
  res.json({ success: true, message: '인증번호가 발송되었습니다.', _devCode: code });
  // ★ _devCode는 개발용 — 실 배포 시 SMS API 연동 후 제거
});

// ── API: 인증번호 확인 ──
app.post('/api/auth/verify-code', (req, res) => {
  const { phone, code } = req.body;
  const entry = verifyCodes.get(phone);
  if (!entry) return res.json({ success: false, message: '인증번호를 먼저 요청해주세요.' });
  if (Date.now() > entry.expiresAt) return res.json({ success: false, message: '인증번호가 만료되었습니다.' });
  if (entry.code !== code) return res.json({ success: false, message: '인증번호가 일치하지 않습니다.' });
  entry.verified = true;
  res.json({ success: true });
});

// ── API: 아이디 찾기 ──
app.post('/api/auth/find-id', (req, res) => {
  const { phone } = req.body;
  const entry = verifyCodes.get(phone);
  if (!entry?.verified) return res.json({ success: false, message: '휴대폰 인증을 먼저 완료해주세요.' });
  const users = loadUsers();
  const user = users.find(u => u.phone === phone);
  if (!user) return res.json({ success: false, message: '해당 번호로 가입된 계정이 없습니다.' });
  // 아이디 일부 마스킹
  const masked = user.username.slice(0, 2) + '*'.repeat(Math.max(1, user.username.length - 4)) + user.username.slice(-2);
  res.json({ success: true, username: masked, createdAt: user.createdAt });
});

// ── API: 비밀번호 재설정 ──
app.post('/api/auth/reset-password', (req, res) => {
  const { username, phone, password } = req.body;
  if (!username || !phone || !password) {
    return res.json({ success: false, message: '모든 항목을 입력해주세요.' });
  }
  if (password.length < 8) {
    return res.json({ success: false, message: '비밀번호는 8자 이상이어야 합니다.' });
  }
  const entry = verifyCodes.get(phone);
  if (!entry?.verified) return res.json({ success: false, message: '휴대폰 인증을 먼저 완료해주세요.' });
  const users = loadUsers();
  const idx = users.findIndex(u => u.username === username && u.phone === phone);
  if (idx === -1) return res.json({ success: false, message: '아이디와 전화번호가 일치하는 계정이 없습니다.' });
  users[idx].password = hashPw(password);
  saveUsers(users);
  console.log(`  [AUTH] 비밀번호 변경: ${username}`);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
// 🛡️ 관리자 API (Admin)
// ══════════════════════════════════════════════════════════
function adminRequired(req, res, next) {
  const cookies = parseCookies(req);
  const session = getSession(cookies.session_token);
  if (!session) return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
  const users = loadUsers();
  const user = users.find(u => u.username === session.username);
  if (!user || user.role !== 'admin') return res.status(403).json({ success: false, message: '관리자 권한이 필요합니다.' });
  req.user = session;
  next();
}

app.get('/api/admin/users', adminRequired, (req, res) => {
  const users = loadUsers();
  res.json(users.map(u => ({ ...u, password: undefined })));
});

app.post('/api/admin/users', adminRequired, (req, res) => {
  const { username, name, email, company, phone, password, role, approved } = req.body;
  if (!username || !name || !password) return res.json({ success: false, message: '아이디, 이름, 비밀번호는 필수입니다.' });
  const users = loadUsers();
  if (users.find(u => u.username === username)) return res.json({ success: false, message: '이미 사용 중인 아이디입니다.' });
  users.push({
    username, name, email: email||'', company: company||'', phone: phone||'',
    referrer:'', memberType:'general', bizDoc:'',
    password: hashPw(password), role: role||'user',
    approved: approved !== false,
    createdAt: new Date().toISOString().split('T')[0]
  });
  saveUsers(users);
  console.log(`  [ADMIN] 회원 추가: ${username} (by ${req.user.username})`);
  res.json({ success: true });
});

app.put('/api/admin/users/:idx', adminRequired, (req, res) => {
  const idx = parseInt(req.params.idx);
  const users = loadUsers();
  if (idx < 0 || idx >= users.length) return res.json({ success: false, message: '회원을 찾을 수 없습니다.' });
  const { name, email, company, phone, password, role, approved } = req.body;
  if (name) users[idx].name = name;
  if (email !== undefined) users[idx].email = email;
  if (company !== undefined) users[idx].company = company;
  if (phone !== undefined) users[idx].phone = phone;
  if (password) users[idx].password = hashPw(password);
  if (role) users[idx].role = role;
  if (approved !== undefined) users[idx].approved = approved;
  saveUsers(users);
  console.log(`  [ADMIN] 회원 수정: ${users[idx].username} (by ${req.user.username})`);
  res.json({ success: true });
});

app.post('/api/admin/users/:idx/approve', adminRequired, (req, res) => {
  const idx = parseInt(req.params.idx);
  const users = loadUsers();
  if (idx < 0 || idx >= users.length) return res.json({ success: false, message: '회원을 찾을 수 없습니다.' });
  users[idx].approved = true;
  saveUsers(users);
  console.log(`  [ADMIN] 회원 승인: ${users[idx].username} (by ${req.user.username})`);
  res.json({ success: true });
});

app.delete('/api/admin/users/:idx', adminRequired, (req, res) => {
  const idx = parseInt(req.params.idx);
  const users = loadUsers();
  if (idx < 0 || idx >= users.length) return res.json({ success: false, message: '회원을 찾을 수 없습니다.' });
  if (users[idx].role === 'admin') return res.json({ success: false, message: '관리자 계정은 삭제할 수 없습니다.' });
  const removed = users.splice(idx, 1)[0];
  saveUsers(users);
  console.log(`  [ADMIN] 회원 삭제: ${removed.username} (by ${req.user.username})`);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
// 브라우저 싱글톤
// ══════════════════════════════════════════════════════════
let browser = null;
let consecutiveFailCount = 0;
let sessionRequestCount = 0;
let isResetting = false;
let _browserGen = 0; // 브라우저 세대 — 리셋 시마다 증가, 구세대 페이지 거부용
const FAIL_THRESHOLD = 12; // ★ 12회 연속 실패 → 빠른 세탁 ★
const SESSION_LIMIT = 300;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  // ★ 시스템 Chrome → puppeteer 번들 Chrome 순으로 탐색 ★
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  let exe = candidates.find(p => fs.existsSync(p));
  // puppeteer 번들 Chrome 자동 탐지 (npx puppeteer browsers install chrome 한 경우)
  if (!exe) {
    try { exe = puppeteer.executablePath(); } catch(e) {}
  }
  if (!exe) {
    console.error('\n  ❌ Chrome을 찾을 수 없습니다! 아래 중 하나를 실행하세요:');
    console.error('     npx puppeteer browsers install chrome');
    console.error('     또는 apt install -y google-chrome-stable\n');
  }
  browser = await puppeteer.launch({
    headless: 'new',  // ★ 신형 headless — 구형(true)은 네이버가 100% 탐지 ★
    ...(exe ? { executablePath: exe } : {}),
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--lang=ko-KR',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',
      '--window-size=390,844',
    ],
    defaultViewport: null,  // ★ page별 viewport 사용 (데스크톱/모바일 불일치 방지) ★
  });
  console.log(`  ✅ Chrome 실행됨: ${exe || '(puppeteer 내장)'}`);
  return browser;
}

// ★ 안티봇 자동 우회: 브라우저 세션 완전 초기화 (Mutex Lock 보호) ★
async function resetBrowser(reason) {
  if (isResetting) return;
  isResetting = true;
  _browserGen++; // ★ 세대 증가 — 이전 세대 페이지 자동 무효화 ★
  console.log(`\n  🔄 [RESET] 브라우저 재시작 (gen=${_browserGen} 사유: ${reason})`);
  try {
    // ★ _pagePool 비우기 (close 안 함! browser.close()가 일괄 처리) ★
    pagePool.length = 0;
    _poolInitCount = 0;

    // ★ 브라우저 한 번에 종료 (개별 page.close 불필요) ★
    if (browser) {
      try { await browser.close(); } catch(e) {}
    }
    browser = null;

    const cooldown = 5000 + Math.random() * 3000;
    console.log(`  ⏳ 쿨다운 ${(cooldown/1000).toFixed(1)}초...`);
    await new Promise(r => setTimeout(r, cooldown));

    await getBrowser();
    console.log(`  ✅ 새 브라우저 세션 시작 (gen=${_browserGen})\n`);
  } catch(e) {
    console.error('  ❌ resetBrowser 오류:', e.message);
  } finally {
    consecutiveFailCount = 0;
    sessionRequestCount = 0;
    isResetting = false;
  }
}

// (recordSuccess/recordFailure 인라인으로 통합됨 — checkRankDual 내부에서 직접 관리)

let ctrl = { pause: false, stop: false, skip: false };
async function waitPause() {
  while (ctrl.pause && !ctrl.stop) await new Promise(r => setTimeout(r, 300));
}

// ══════════════════════════════════════════════════════════
// ██  업종 감지 키워드 → 업종코드 매핑  ██
// ══════════════════════════════════════════════════════════
const CAT_MAP = {
  // ── 음식/식당 ──
  food: [
    '한식','중식','일식','양식','분식','패스트푸드','뷔페','도시락',
    '칼국수','국수','냉면','우동','라멘','쌀국수','소바','만두',
    '삼겹살','갈비','한우','스테이크','닭갈비','보쌈','족발','수육',
    '찌개','해장국','순대','삼계탕','설렁탕','곰탕','뼈해장국','콩나물국밥',
    '비빔밥','덮밥','쌈밥','백반','솥밥','돌솥','솥뚜껑','감자탕',
    '치킨','해산물','횟집','초밥','파스타','피자','버거','샌드위치',
    '곱창','막창','대창','낙지','꼼장어','장어','꽃게','대게','랍스터',
    '포차','주점','이자카야','선술집','와인바','맥줏집','호프',
    '돈카츠','텐동','오야코동','규동','가라아게','라멘집',
    '마라탕','훠궈','양꼬치','딤섬','마라샹궈','탕수육',
    '오마카세','스시','사시미','롤','스테이크하우스',
    '샤브샤브','나베','전골','두부','청국장','순두부',
    '식당','음식점','밥집','맛집',
  ],
  // ── 카페/디저트 ──
  cafe: [
    '카페','커피','에스프레소','스페셜티','로스터리','브루잉',
    '베이커리','빵집','소금빵','크루아상','마카롱','케이크','타르트',
    '브런치','와플','팬케이크','도넛','크로플','스콘','베이글',
    '버블티','흑당','타피오카','밀크티','마라탕카페',
    '아이스크림','젤라또','소프트아이스크림','빙수','팥빙수',
    '디저트','디저트카페','스무디','주스','착즙',
    '루프탑카페','애견카페','북카페','감성카페','뷰카페',
  ],
  // ── 미용/헤어 ──
  beauty_hair: [
    '미용실','헤어','헤어샵','헤어살롱','hair',
    '커트','염색','탈색','펌','디지털펌','매직','볼륨매직',
    '케라틴','클리닉펌','레이어드','히트','히피펌',
    '두피관리','두피케어','붙임머리','가발',
    '남성미용실','바버샵','barber',
  ],
  // ── 네일/속눈썹/반영구 ──
  beauty_nail: [
    '네일','네일샵','네일아트','젤네일','아트네일','페디큐어',
    '속눈썹','속눈썹샵','래쉬','lash','볼륨래쉬','엑스텐션',
    '반영구','반영구메이크업','눈썹','눈썹문신','아이라인','입술','헤어라인',
    '타투','이니셜타투','미니타투','타투샵',
  ],
  // ── 피부/왁싱/마사지 ──
  beauty_skin: [
    '피부관리','피부샵','피부관리실','스킨케어','에스테틱',
    '왁싱','브라질리언','왁싱샵','제모',
    '마사지','스웨디시','아로마','경락','태국마사지','발마사지','림프','힐링',
    '스파','바디샵','릴렉스','체형관리',
  ],
  // ── 피부과/성형외과 ──
  medical_skin: [
    '피부과','피부과의원','피부과병원',
    '성형외과','성형','성형클리닉',
    '보톡스','필러','리프팅','실리프팅','레이저','토닝','IPL',
    '여드름','모공','잡티','색소','점빼기','제모레이저',
  ],
  // ── 치과 ──
  medical_dental: [
    '치과','치과의원','치과병원','dental',
    '임플란트','치아교정','교정','라미네이트','스케일링','사랑니','치아미백',
    '틀니','충치','신경치료','잇몸치료',
  ],
  // ── 한의원 ──
  medical_korean: [
    '한의원','한의','한방','한방병원','한방클리닉',
    '침','뜸','추나','한약','탕약','첩약',
    '다이어트한약','교통사고한의원','척추교정',
  ],
  // ── 정형외과/재활 ──
  medical_ortho: [
    '정형외과','재활의학과','통증의학과',
    '도수치료','물리치료','체외충격파','주사치료','신경치료',
    '허리디스크','목디스크','무릎','어깨','관절','척추',
  ],
  // ── 안과 ──
  medical_eye: [
    '안과','안과의원','eye',
    '라식','라섹','스마일라식','스마일','안경처방','드림렌즈','백내장','녹내장',
  ],
  // ── 이비인후과 ──
  medical_ent: [
    '이비인후과','이비인후','ENT',
    '비염','축농증','중이염','편도','코골이','알레르기','비중격',
  ],
  // ── 내과/가정의학과 ──
  medical_internal: [
    '내과','가정의학과','내과의원','건강검진',
    '위내시경','대장내시경','당뇨','혈압','갑상선','소화불량',
  ],
  // ── 산부인과/소아과 ──
  medical_ob: [
    '산부인과','소아과','소아청소년과','여성병원',
    '임신','산전','분만','초음파','소아',
  ],
  // ── 학원/교육 ──
  edu_english: ['영어학원','영어','영어회화','토익','IELTS','원어민','파닉스','스피킹'],
  edu_math:    ['수학학원','수학','수능수학','중등수학','고등수학','미적분','입시수학'],
  edu_art_music: [
    '음악학원','미술학원','피아노','바이올린','첼로','기타','드럼','보컬','성악',
    '미술','그림','수채화','소묘','웹툰','그림학원',
  ],
  edu_sports: [
    '태권도','유도','검도','합기도','주짓수','권투','복싱','킥복싱','무에타이',
    '수영','수영강습','수영장','스케이트','승마',
  ],
  edu_coding: ['코딩학원','코딩','프로그래밍','소프트웨어','IT학원','파이썬','앱개발'],
  // ── 필라테스/요가/피트니스 ──
  fitness_pilates: ['필라테스','필라테스샵','기구필라테스','그룹필라테스','재활필라테스'],
  fitness_yoga:    ['요가','요가원','하타요가','빈야사','핫요가','인요가','명상'],
  fitness_gym:     ['헬스장','헬스','PT','퍼스널트레이닝','웨이트','크로스핏','바디프로필','다이어트'],
  fitness_golf:    ['골프','골프연습장','스크린골프','실내골프','골프레슨','골프아카데미'],
  fitness_climb:   ['클라이밍','클라이밍장','암벽등반','실내클라이밍','볼더링'],
  // ── 인테리어/리모델링 ──
  interior: [
    '인테리어','리모델링','인테리어업체','인테리어회사',
    '도배','도배업체','실크도배','합지도배',
    '타일','바닥재','마루','강화마루','타일시공',
    '창호','샷시','창문','이중창','방음창',
    '욕실','욕실리모델링','주방','싱크대','붙박이장',
    '조명','전기','전기공사','LED조명',
    '철거','이사','폐기물','쓰레기처리',
  ],
  // ── 자동차 ──
  car: [
    '자동차정비','카센터','정비소','공업사','카공',
    '타이어','타이어교체','타이어샵',
    '세차','세차장','손세차','자동세차','유리막코팅','광택','썬팅','틴팅',
    '블랙박스','블랙박스설치','카오디오','자동차용품',
    '엔진오일','오일교환','브레이크','냉각수','에어컨충전',
  ],
  // ── 반려동물 ──
  pet: [
    '동물병원','동물의료원','수의사','펫병원','고양이병원','강아지병원',
    '애견미용','펫샵','애견샵','동물샵','반려동물샵',
    '강아지유치원','펫호텔','펫시터','반려동물호텔',
    '강아지','고양이','반려동물','펫',
  ],
  // ── 부동산/금융/법률 ──
  business_service: [
    '부동산','공인중개사','부동산중개','중개사무소',
    '세무사','세무','회계','회계사','세무법인',
    '법무사','변호사','법률사무소','법무법인',
    '보험','보험설계사','재무설계',
    '대출','담보대출','신용대출','모기지',
  ],
  // ── 사진/스튜디오 ──
  photo_studio: [
    '사진관','스튜디오','증명사진','프로필사진','가족사진','돌사진','웨딩사진',
    '셀프스튜디오','반명함사진','여권사진','우정사진','만삭사진','뉴본사진',
  ],
  // ── 꽃집/플라워 ──
  flower: [
    '꽃집','플라워','화원','꽃다발','꽃배달','화환','꽃바구니','드라이플라워',
    '웨딩부케','축하화환','근조화환','개업화환','플라워카페',
  ],
  // ── 세탁/수선 ──
  laundry: [
    '세탁소','세탁','드라이클리닝','이불세탁','운동화세탁','명품세탁',
    '수선','옷수선','신발수선','가방수선','지퍼수선','양복수선',
  ],
  // ── 이사/청소 ──
  moving: [
    '이사','포장이사','이삿짐','원룸이사','사무실이사','용달이사',
    '청소','이사청소','입주청소','에어컨청소','업소청소','정리수납',
  ],
  // ── 열쇠/잠금 ──
  locksmith: [
    '열쇠','자물쇠','열쇠집','잠금장치','자동차열쇠','도어락','번호키',
  ],
  // ── 약국 ──
  pharmacy: [
    '약국','약사','의약품','처방전','야간약국','24시약국',
  ],
  // ── 기타 생활서비스 (포괄) ──
  life_service: [
    '인쇄소','복사','명함','간판','현수막','배관','수도','보일러','도시가스',
    '방충망','방역','해충','소독','방수','누수',
  ],
  // ── 숙박 ──
  stay: [
    '호텔','모텔','여관','여인숙','게스트하우스','호스텔',
    '펜션','펜션숙박','독채펜션','풀빌라','풀빌라펜션',
    '리조트','콘도','콘도미니엄',
    '캠핑장','오토캠핑','글램핑','카라반','텐트',
    '에어비앤비','숙소','숙박',
  ],
  // ── 유흥/엔터 ──
  entertain: [
    '노래방','코인노래방','주점','바','클럽','라운지',
    '볼링장','당구장','다트','보드게임카페','방탈출',
    'PC방','오락실','VR','스크린야구',
  ],
};

// 역방향 매핑: 키워드 → 업종코드
const KEYWORD_TO_CAT = {};
for (const [catCode, keywords] of Object.entries(CAT_MAP)) {
  for (const kw of keywords) KEYWORD_TO_CAT[kw] = catCode;
}

// ══════════════════════════════════════════════════════════
// ██  업종코드 → 4슬롯 설정 (핵심!)  ██
// ══════════════════════════════════════════════════════════
const CAT_CONFIG = {
  food: {
    label: '음식점/식당',
    // 슬롯4: 의도어
    intents: ['맛집','추천','맛있는곳','유명한','인기','1등','최고','현지인맛집','핫플','유명맛집','인기맛집','가성비','잘하는곳','괜찮은곳','후기좋은','가볼만한','어디','먹을곳','갈만한곳','좋은곳'],
    // 상황어
    sits: ['점심','저녁','야식','아침','데이트','혼밥','가족','회식','주말','단체','모임','회식자리','점심특선','가성비','브런치','혼술','소개팅','생일','기념일','접대','2인','4인','토요일','일요일'],
    // 수식어
    mods: ['분위기좋은','뷰좋은','오션뷰','가성비','인스타','감성','숨은','오래된','전통','신상','현지인','로컬','줄서는','인생맛집'],
    // 서비스 뒤에 붙는 의도어
    suffix: ['맛집','추천','유명','인기','잘하는'],
    // 업종 단독 검색어
    alone: ['맛집','식당','음식점'],
  },
  cafe: {
    label: '카페/디저트',
    intents: ['카페','추천','맛있는','유명한','인기','핫플','분위기좋은','인스타','감성','숨은','예쁜','1등','뷰좋은','갈만한','가볼만한','좋은','괜찮은','후기좋은'],
    sits: ['데이트','공부','작업','혼카공','주말','모임','브런치','오전','오후','감성','인스타','소개팅','친구','커플','혼자','비오는날','토요일'],
    mods: ['감성카페','뷰카페','루프탑카페','애견카페','북카페','오션뷰','인스타카페','대형카페','포토존','조용한카페','넓은카페','이쁜카페','공부하기좋은','작업하기좋은'],
    suffix: ['카페','맛집','추천','인기','유명','갈만한','핫플'],
    alone: ['카페','커피','디저트','브런치카페','베이커리'],
  },
  beauty_hair: {
    label: '미용실/헤어샵',
    intents: ['잘하는','추천','잘하는곳','실력좋은','저렴한','후기좋은','유명한','인기','전문','꼼꼼한','잘해주는','예쁘게','괜찮은','어디','가볼만한','싼곳','가성비'],
    sits: ['결혼준비','웨딩','직장인','주말','당일','예약없이','저렴한','남자','여자','대학생','학생','토요일','일요일','커트만'],
    mods: ['깔끔한','위생적인','꼼꼼한','친절한','합리적인','실력좋은','경력있는','전문','예약가능한','가성비좋은'],
    suffix: ['잘하는','추천','잘하는곳','유명한','저렴한','인기','가성비'],
    alone: ['미용실','헤어샵','헤어','헤어살롱','바버샵'],
  },
  beauty_nail: {
    label: '네일/속눈썹/반영구',
    intents: ['잘하는','추천','잘하는곳','실력좋은','저렴한','후기좋은','예쁜','섬세한','전문','꼼꼼한'],
    sits: ['결혼준비','웨딩','특별한날','기념일','생일','직장인','주말','당일'],
    mods: ['깔끔한','위생','꼼꼼한','친절한','합리적인','예쁜','감각있는','트렌디한'],
    suffix: ['잘하는','추천','잘하는곳','유명한','저렴한','인기','예쁜'],
    alone: ['네일','속눈썹','반영구'],
  },
  beauty_skin: {
    label: '피부관리/왁싱/마사지',
    intents: ['잘하는','추천','잘하는곳','실력좋은','저렴한','후기좋은','전문','효과좋은','꼼꼼한'],
    sits: ['결혼준비','웨딩','직장인','주말','당일','여름전','겨울관리','스트레스해소'],
    mods: ['깔끔한','위생','친절한','합리적인','전문적인','효과좋은','경력있는'],
    suffix: ['잘하는','추천','잘하는곳','유명한','저렴한','인기','전문'],
    alone: ['피부관리','왁싱','마사지','스파'],
  },
  medical_skin: {
    label: '피부과/성형외과',
    intents: ['잘하는','추천','유명한','실력좋은','후기좋은','전문의','저렴한','경력많은','잘보는'],
    sits: ['여드름','노화관리','결혼준비','피부개선','빠른','당일'],
    mods: ['친절한','설명잘해주는','경력많은','장비좋은','위생','전문의','빠른'],
    suffix: ['잘하는','추천','유명한','잘하는곳','전문','인기'],
    alone: ['피부과','성형외과','피부클리닉'],
  },
  medical_dental: {
    label: '치과',
    intents: ['잘하는','추천','유명한','실력좋은','후기좋은','전문의','저렴한','경력많은','잘보는','친절한'],
    sits: ['빠른','당일','통증없는','어린이','노인','직장인','주말','토요일'],
    mods: ['친절한','설명잘해주는','통증없는','장비좋은','위생','경력있는','전문의'],
    suffix: ['잘하는','추천','유명한','잘하는곳','저렴한','인기'],
    alone: ['치과','치과의원'],
  },
  medical_korean: {
    label: '한의원',
    intents: ['잘하는','추천','유명한','실력좋은','후기좋은','전문','경력많은','효과좋은','잘보는'],
    sits: ['다이어트','교통사고','만성피로','불면증','면역력','여성','체질개선','갱년기'],
    mods: ['친절한','설명잘해주는','경력있는','유명한','효과좋은','전통있는'],
    suffix: ['잘하는','추천','유명한','잘하는곳','인기','전문'],
    alone: ['한의원','한방','한의'],
  },
  medical_ortho: {
    label: '정형외과/재활',
    intents: ['잘하는','추천','유명한','실력좋은','후기좋은','전문의','경력많은','잘보는','효과좋은'],
    sits: ['허리','무릎','어깨','교통사고','빠른','당일','재활'],
    mods: ['친절한','설명잘해주는','경력있는','유명한','장비좋은','전문의'],
    suffix: ['잘하는','추천','유명한','잘하는곳','전문','인기'],
    alone: ['정형외과','통증의학과','재활의학과'],
  },
  medical_eye: {
    label: '안과',
    intents: ['잘하는','추천','유명한','실력좋은','후기좋은','전문의','저렴한','경력많은'],
    sits: ['시력교정','노안','백내장','빠른','당일'],
    mods: ['친절한','설명잘해주는','경력있는','장비좋은','전문의'],
    suffix: ['잘하는','추천','유명한','잘하는곳','전문','인기'],
    alone: ['안과','안과의원'],
  },
  medical_ent: {
    label: '이비인후과',
    intents: ['잘하는','추천','유명한','실력좋은','후기좋은','전문의','친절한','잘보는'],
    sits: ['비염','코막힘','편도','중이염','빠른','당일','어린이'],
    mods: ['친절한','설명잘해주는','대기짧은','전문의','경력있는'],
    suffix: ['잘하는','추천','유명한','잘하는곳','인기'],
    alone: ['이비인후과'],
  },
  medical_internal: {
    label: '내과/건강검진',
    intents: ['잘하는','추천','유명한','실력좋은','후기좋은','전문의','친절한','잘보는'],
    sits: ['건강검진','내시경','혈압','당뇨','빠른','당일','주말'],
    mods: ['친절한','설명잘해주는','대기짧은','전문의','경력있는'],
    suffix: ['잘하는','추천','유명한','잘하는곳','인기'],
    alone: ['내과','가정의학과','건강검진'],
  },
  medical_ob: {
    label: '산부인과/소아과',
    intents: ['잘하는','추천','유명한','실력좋은','후기좋은','전문의','친절한','잘보는'],
    sits: ['임신','분만','산전','소아','영유아','빠른'],
    mods: ['친절한','설명잘해주는','전문의','경력있는','여의사'],
    suffix: ['잘하는','추천','유명한','잘하는곳','인기'],
    alone: ['산부인과','소아과','소아청소년과'],
  },
  edu_english: {
    label: '영어학원',
    intents: ['잘하는','추천','유명한','성적오른','체계적인','실력있는','성과좋은','인기','전문','합격률'],
    sits: ['초등','중등','성인','직장인','수능','원어민','토익','회화','주말'],
    mods: ['체계적인','커리큘럼','원어민','소수정예','성과좋은','유명한'],
    suffix: ['잘하는','추천','유명한','잘하는곳','인기','전문'],
    alone: ['영어학원','영어'],
  },
  edu_math: {
    label: '수학학원',
    intents: ['잘하는','추천','유명한','성적오른','체계적인','실력있는','성과좋은','인기','전문','합격률'],
    sits: ['초등','중등','고등','수능','내신','심화','선행','주말'],
    mods: ['체계적인','커리큘럼','소수정예','성과좋은','성적향상','유명한'],
    suffix: ['잘하는','추천','유명한','잘하는곳','인기','전문'],
    alone: ['수학학원','수학'],
  },
  edu_art_music: {
    label: '음악/미술학원',
    intents: ['잘하는','추천','유명한','실력있는','체계적인','인기','전문','입시','취미'],
    sits: ['초등','중등','입시','취미','성인','어린이','방과후','주말'],
    mods: ['체계적인','소수정예','전문','유명한','입시전문','친절한'],
    suffix: ['잘하는','추천','유명한','잘하는곳','인기'],
    alone: ['음악학원','미술학원','피아노학원'],
  },
  edu_sports: {
    label: '스포츠/무도 학원',
    intents: ['잘하는','추천','유명한','실력있는','체계적인','인기','전문','친절한'],
    sits: ['어린이','초등','성인','취미','주말','저녁','방과후'],
    mods: ['체계적인','전문','유명한','안전한','소수정예','친절한'],
    suffix: ['잘하는','추천','유명한','잘하는곳','인기','전문'],
    alone: ['태권도','검도','수영','합기도'],
  },
  edu_coding: {
    label: '코딩학원',
    intents: ['잘하는','추천','유명한','실력있는','체계적인','인기','전문'],
    sits: ['초등','중등','성인','취업준비','주말','방과후'],
    mods: ['체계적인','커리큘럼','전문','유명한','취업률'],
    suffix: ['잘하는','추천','유명한','잘하는곳','인기'],
    alone: ['코딩학원','코딩','프로그래밍'],
  },
  fitness_pilates: {
    label: '필라테스',
    intents: ['잘하는','추천','유명한','실력있는','후기좋은','저렴한','인기','전문','친절한'],
    sits: ['다이어트','재활','산전','산후','직장인','주말','저녁','아침','초보','취미'],
    mods: ['소수정예','1대1','기구','그룹','친절한','전문강사','체계적인','시설좋은'],
    suffix: ['잘하는','추천','유명한','잘하는곳','인기','저렴한'],
    alone: ['필라테스','필라테스샵'],
  },
  fitness_yoga: {
    label: '요가원',
    intents: ['잘하는','추천','유명한','실력있는','후기좋은','저렴한','인기','전문','친절한'],
    sits: ['다이어트','명상','산전','직장인','주말','아침','저녁','초보','취미'],
    mods: ['소수정예','1대1','친절한','전문강사','체계적인','시설좋은','힐링'],
    suffix: ['잘하는','추천','유명한','잘하는곳','인기','저렴한'],
    alone: ['요가','요가원'],
  },
  fitness_gym: {
    label: '헬스장/PT',
    intents: ['잘하는','추천','유명한','저렴한','후기좋은','인기','시설좋은','친절한'],
    sits: ['다이어트','바디프로필','직장인','주말','아침','저녁','24시간','초보'],
    mods: ['시설좋은','기구좋은','24시간','친절한','깨끗한','가성비','넓은'],
    suffix: ['잘하는','추천','유명한','저렴한','인기','시설좋은'],
    alone: ['헬스장','헬스','피트니스'],
  },
  fitness_golf: {
    label: '골프/골프연습장',
    intents: ['잘하는','추천','유명한','저렴한','후기좋은','인기','시설좋은','실력있는'],
    sits: ['입문','초보','취미','직장인','주말','저녁','레슨'],
    mods: ['시설좋은','레슨잘하는','체계적인','친절한','가성비','깨끗한'],
    suffix: ['잘하는','추천','유명한','저렴한','인기','시설좋은'],
    alone: ['골프','골프연습장','스크린골프'],
  },
  fitness_climb: {
    label: '클라이밍',
    intents: ['잘하는','추천','유명한','저렴한','후기좋은','인기','시설좋은'],
    sits: ['초보','입문','취미','직장인','주말','저녁'],
    mods: ['시설좋은','넓은','깨끗한','가성비','친절한'],
    suffix: ['추천','유명한','인기','시설좋은'],
    alone: ['클라이밍','클라이밍장','볼더링'],
  },
  interior: {
    label: '인테리어/시공',
    intents: ['잘하는','추천','유명한','저렴한','후기좋은','전문','믿을수있는','잘해주는','시공잘하는'],
    sits: ['아파트','빌라','주택','사무실','카페','식당','신축','구축','입주전'],
    mods: ['합리적인','저렴한','꼼꼼한','친절한','전문업체','경험많은','빠른시공','깔끔한'],
    suffix: ['잘하는','추천','유명한','저렴한','전문','잘해주는'],
    alone: ['인테리어','리모델링','인테리어업체'],
  },
  car: {
    label: '자동차/카센터',
    intents: ['잘하는','추천','유명한','저렴한','후기좋은','전문','믿을수있는','친절한','빠른'],
    sits: ['당일','빠른','저렴한','친절한','신속한'],
    mods: ['합리적인','저렴한','꼼꼼한','친절한','전문','빠른','가성비'],
    suffix: ['잘하는','추천','유명한','저렴한','전문','인기'],
    alone: ['카센터','자동차정비','세차'],
  },
  pet: {
    label: '반려동물/동물병원',
    intents: ['잘하는','추천','유명한','저렴한','후기좋은','전문의','믿을수있는','친절한','잘보는'],
    sits: ['강아지','고양이','소동물','응급','당일','예방접종','미용'],
    mods: ['친절한','섬세한','꼼꼼한','경력있는','전문의','깨끗한'],
    suffix: ['잘하는','추천','유명한','잘하는곳','전문','인기'],
    alone: ['동물병원','애견미용','펫샵'],
  },
  business_service: {
    label: '부동산/세무/법무',
    intents: ['잘하는','추천','유명한','저렴한','후기좋은','전문','믿을수있는','친절한','경험많은'],
    sits: ['매매','전세','월세','세금신고','상속','법인','창업','이혼','부동산'],
    mods: ['합리적인','친절한','경험많은','전문','믿을수있는','빠른처리'],
    suffix: ['잘하는','추천','유명한','저렴한','전문','인기'],
    alone: ['부동산','세무사','법무사'],
  },
  life_service: {
    label: '생활서비스',
    intents: ['잘하는','추천','유명한','저렴한','후기좋은','전문','친절한','빠른'],
    sits: ['당일','빠른','저렴한','주말'],
    mods: ['저렴한','친절한','빠른','꼼꼼한','전문'],
    suffix: ['잘하는','추천','유명한','저렴한','인기'],
    alone: ['인쇄소','배관','보일러','방역'],
  },
  photo_studio: {
    label: '사진관/스튜디오',
    intents: ['잘하는','추천','잘찍는','예쁘게','보정잘하는','후기좋은','유명한','저렴한','감성','인기'],
    sits: ['증명사진','프로필','가족사진','돌사진','웨딩','커플','우정','만삭','뉴본','졸업','여권사진'],
    mods: ['감성','예쁜','깔끔한','자연스러운','보정잘하는','친절한','전문','트렌디한'],
    suffix: ['잘찍는','추천','유명한','잘하는곳','인기','예쁜','저렴한'],
    alone: ['사진관','스튜디오','셀프스튜디오','포토스튜디오'],
  },
  flower: {
    label: '꽃집/플라워샵',
    intents: ['추천','예쁜','유명한','저렴한','감성','인기','후기좋은','센스있는','잘하는'],
    sits: ['생일','기념일','프로포즈','결혼식','개업','축하','근조','졸업','발표회','어버이날'],
    mods: ['예쁜','감성','고급','저렴한','신선한','센스있는','트렌디한'],
    suffix: ['추천','예쁜','유명한','저렴한','인기','잘하는'],
    alone: ['꽃집','플라워','화원','꽃배달','꽃다발'],
  },
  laundry: {
    label: '세탁소/수선',
    intents: ['잘하는','추천','저렴한','후기좋은','빠른','친절한','깨끗한','전문'],
    sits: ['당일','빠른세탁','명품','이불','운동화','양복','드라이'],
    mods: ['깨끗한','꼼꼼한','친절한','빠른','저렴한','전문'],
    suffix: ['잘하는','추천','저렴한','인기','가성비'],
    alone: ['세탁소','세탁','수선','옷수선'],
  },
  moving: {
    label: '이사/청소업체',
    intents: ['잘하는','추천','저렴한','후기좋은','믿을수있는','친절한','전문','빠른','꼼꼼한'],
    sits: ['원룸','투룸','아파트','사무실','용달','소형','당일','주말'],
    mods: ['저렴한','친절한','꼼꼼한','빠른','전문','합리적인','가성비'],
    suffix: ['잘하는','추천','저렴한','인기','전문','가성비'],
    alone: ['이사','포장이사','입주청소','이사청소'],
  },
  locksmith: {
    label: '열쇠/잠금장치',
    intents: ['잘하는','추천','저렴한','빠른','후기좋은','24시','야간','출장'],
    sits: ['당일','야간','긴급','출장','새벽','주말','공휴일'],
    mods: ['빠른','저렴한','친절한','24시간','출장','전문'],
    suffix: ['잘하는','추천','저렴한','빠른','24시'],
    alone: ['열쇠','자물쇠','도어락','번호키'],
  },
  pharmacy: {
    label: '약국',
    intents: ['추천','가까운','친절한','야간','24시','주말','공휴일영업'],
    sits: ['야간','주말','공휴일','당일','처방전','OTC'],
    mods: ['친절한','가까운','야간영업','24시간','주말영업'],
    suffix: ['추천','가까운','인기','친절한'],
    alone: ['약국','24시약국','야간약국'],
  },
  stay: {
    label: '숙박/호텔/펜션',
    intents: ['추천','예쁜','뷰좋은','가성비','인기','후기좋은','커플','가족','깔끔한','감성'],
    sits: ['1박2일','2박3일','커플','가족','단체','혼자','반려동물','반려견','여름','겨울','연휴','주말'],
    mods: ['오션뷰','풀빌라','바베큐','독채','감성','뷰좋은','인스타','예쁜','새벽'],
    suffix: ['추천','인기','후기좋은','뷰좋은','가성비'],
    alone: ['호텔','펜션','글램핑','풀빌라'],
  },
  entertain: {
    label: '오락/엔터테인먼트',
    intents: ['추천','재밌는','인기','후기좋은','유명한','가성비','저렴한'],
    sits: ['친구','커플','데이트','가족','주말','야간','저녁'],
    mods: ['재밌는','인기있는','넓은','깨끗한','가성비','신상'],
    suffix: ['추천','인기','재밌는','유명한'],
    alone: ['노래방','볼링장','방탈출','보드게임'],
  },
};

// 기본값 (업종 감지 실패 시)
const DEFAULT_CONFIG = CAT_CONFIG['food'];

// ══════════════════════════════════════════════════════════
// ██  업종별 서비스/메뉴 힌트  ██
// ══════════════════════════════════════════════════════════
const SERVICE_HINT = {
  food:           ['손칼국수','바지락칼국수','들깨칼국수','수제비','삼겹살','목살','갈비','한우','초밥','회','파스타','피자','치킨','버거','제육볶음','불고기','비빔밥','된장찌개','김치찌개','국밥','해장국'],
  cafe:           ['아메리카노','라떼','핸드드립','스페셜티','콜드브루','플랫화이트','소금빵','크루아상','마카롱','케이크','타르트','와플','크로플','베이글'],
  beauty_hair:    ['커트','염색','탈색','펌','디지털펌','케라틴','볼륨매직','뿌리염색','두피케어','클리닉펌','붙임머리','히트','레이어드'],
  beauty_nail:    ['젤네일','아트네일','페디큐어','젤오프','네일아트','볼륨래쉬','엑스텐션','래쉬리프트','속눈썹펌','눈썹','아이라인','입술','미니타투','이니셜타투'],
  beauty_skin:    ['전신마사지','스웨디시','아로마','경락','발마사지','림프마사지','수분관리','여드름관리','리프팅','미백','모공관리','브라질리언왁싱','전신왁싱','다리왁싱'],
  medical_skin:   ['보톡스','필러','리프팅','실리프팅','레이저토닝','IPL','여드름치료','모공','색소치료','점빼기','제모','쌍꺼풀','코성형','지방흡입'],
  medical_dental: ['임플란트','치아교정','라미네이트','스케일링','사랑니','치아미백','틀니','충치','신경치료','잇몸치료'],
  medical_korean: ['침','추나','한약','탕약','다이어트한약','교통사고','불면증','척추교정','면역치료','체질개선'],
  medical_ortho:  ['도수치료','물리치료','체외충격파','주사치료','허리디스크','목디스크','무릎관절','어깨','척추교정'],
  medical_eye:    ['라식','라섹','스마일라식','안경처방','드림렌즈','백내장','녹내장'],
  medical_ent:    ['비염치료','축농증','중이염','편도','코골이','알레르기','비중격'],
  medical_internal:['건강검진','위내시경','대장내시경','혈압','당뇨','갑상선','소화불량'],
  medical_ob:     ['산전검사','임신확인','초음파','피임','자궁경부암검사'],
  edu_english:    ['영어회화','토익','원어민수업','파닉스','스피킹','라이팅','IELTS'],
  edu_math:       ['중등수학','고등수학','수능수학','미적분','확률통계','내신','선행','심화'],
  edu_art_music:  ['피아노','바이올린','기타','드럼','보컬','수채화','소묘','입시미술'],
  edu_sports:     ['태권도','유도','검도','합기도','수영강습','수영','복싱','주짓수'],
  edu_coding:     ['파이썬','자바','앱개발','웹개발','코딩','프로그래밍','AI','블록코딩'],
  fitness_pilates:['그룹필라테스','개인레슨','기구필라테스','재활','산전필라테스','소도구필라테스'],
  fitness_yoga:   ['하타요가','빈야사','핫요가','인요가','명상요가','산전요가','커플요가'],
  fitness_gym:    ['PT','퍼스널트레이닝','웨이트','유산소','크로스핏','바디프로필','다이어트'],
  fitness_golf:   ['스크린골프','골프레슨','드라이버','아이언','퍼팅','쇼트게임'],
  fitness_climb:  ['볼더링','리드','선등','초보클라이밍','클라이밍교실'],
  interior:       ['아파트인테리어','욕실인테리어','주방인테리어','거실인테리어','전체인테리어','사무실인테리어','합지도배','실크도배','욕실타일','바닥타일','창호교체','붙박이장','싱크대교체'],
  car:            ['엔진오일교환','타이어교체','브레이크패드','손세차','유리막코팅','광택','썬팅','블랙박스설치','냉각수','에어컨충전'],
  pet:            ['예방접종','중성화수술','치석제거','건강검진','슬개골','심장사상충','전체미용','목욕','발톱정리','부분미용'],
  business_service:['매매','전세','월세','세금신고','법인세','소득세','상속','증여','이혼','부동산중개'],
  life_service:   ['증명사진','프로필사진','가족사진','꽃다발','화환','드라이클리닝','이불세탁','포장이사','입주청소'],
  stay:           ['독채펜션','풀빌라','바베큐','오션뷰','마운틴뷰','반려동물동반','1박2일','글램핑','카라반'],
  entertain:      ['코인노래방','일반룸','파티룸','주류','다트','스크린야구','VR','방탈출'],
};

// ══════════════════════════════════════════════════════════
// ██  전국 지역명 + 랜드마크 DB  ██
// ══════════════════════════════════════════════════════════
// 광역시/도 대표 지역 (전국 커버)
const CITY_ALIAS = {
  '서울특별시':'서울','부산광역시':'부산','인천광역시':'인천','대구광역시':'대구',
  '대전광역시':'대전','광주광역시':'광주','울산광역시':'울산','세종특별자치시':'세종',
  '경기도':'경기','강원도':'강원','충청북도':'충북','충청남도':'충남',
  '전라북도':'전북','전라남도':'전남','경상북도':'경북','경상남도':'경남',
  '제주특별자치도':'제주',
};

// 전국 주요 지역 + 역세권
const LANDMARK_DB = {
  // ── 서울 ──
  '홍대':     { station:['홍대입구역','상수역','합정역'], sights:['홍대거리','연남동','경의선숲길'], },
  '강남':     { station:['강남역','역삼역','선릉역','삼성역'], sights:['가로수길','청담동'], shopping:['코엑스','신세계강남'], },
  '이태원':   { station:['이태원역','한강진역'], sights:['이태원거리','경리단길','해방촌'], },
  '성수':     { station:['성수역','뚝섬역'], sights:['성수동','서울숲','성수연방'], },
  '잠실':     { station:['잠실역'], shopping:['롯데월드타워','잠실롯데몰'], sights:['석촌호수','롯데월드'], },
  '신촌':     { station:['신촌역','이대역'], sights:['신촌거리','연세로'], },
  '명동':     { station:['명동역','을지로입구역'], sights:['명동거리','남산'], shopping:['롯데백화점명동','신세계명동'], },
  '종로':     { station:['종각역','종로3가역'], sights:['광화문','경복궁','인사동','익선동'], },
  '건대':     { station:['건대입구역','구의역'], sights:['건대맛집거리','어린이대공원'], },
  '왕십리':   { station:['왕십리역'], shopping:['이마트왕십리'], },
  '망원':     { station:['망원역','합정역'], sights:['망원한강공원','망원시장','망리단길'], },
  '여의도':   { station:['여의도역'], sights:['여의도한강공원'], shopping:['더현대서울','IFC몰'], },
  '영등포':   { station:['영등포역','영등포구청역'], shopping:['타임스퀘어','롯데백화점영등포'], },
  '목동':     { station:['목동역','오목교역'], shopping:['현대백화점목동'], apt:['목동아파트'] },
  '노원':     { station:['노원역','상계역'], shopping:['롯데백화점노원'], },
  '서초':     { station:['서초역','방배역','반포역'], apt:['반포자이','래미안퍼스티지'], },
  '송파':     { station:['송파역','가락시장역'], apt:['헬리오시티','파크리오'], },
  '마포':     { station:['마포역','공덕역','아현역'], },
  '용산':     { station:['용산역','삼각지역','이촌역'], shopping:['아이파크몰','이마트용산'], },
  '강동':     { station:['강동역','길동역','천호역'], shopping:['이마트강동'], },
  '구로':     { station:['구로역','신도림역','디지털단지역'], shopping:['롯데백화점구로'], },
  '신림':     { station:['신림역','봉천역'], },
  '방이':     { station:['방이역','올림픽공원역'], sights:['올림픽공원'], },
  '광화문':   { station:['광화문역','경복궁역'], sights:['광화문','경복궁','청계천'], },
  '을지로':   { station:['을지로입구역','을지로3가역','을지로4가역'], sights:['을지로 힙지로'], },
  // ── 부산 ──
  '해운대':   { station:['해운대역','중동역','벡스코역','동백역'], sights:['해운대해수욕장','동백섬','달맞이고개','청사포'], shopping:['신세계센텀시티','벡스코'], hotel:['파라다이스호텔','노보텔해운대'], apt:['해운대아이파크','위브더제니스','엘시티'], },
  '마린시티': { station:['동백역'], sights:['더베이101','마린시티'], apt:['마린시티아이파크','현대하이페리온'], },
  '광안리':   { station:['광안역','민락역'], sights:['광안리해수욕장','광안대교','민락수변공원'], },
  '남천':     { station:['남천역','수영역'], sights:['남천해수욕장','남천삼익비치'], apt:['남천삼익비치','남천엑슬루타워'], },
  '수영':     { station:['수영역'], shopping:['이마트수영'], },
  '센텀':     { station:['센텀시티역','벡스코역'], shopping:['신세계센텀시티','벡스코','이케아'], },
  '전포':     { station:['전포역','서면역'], sights:['전포카페거리'], },
  '서면':     { station:['서면역'], shopping:['롯데백화점부산본점'], },
  '동래':     { station:['동래역','온천장역'], sights:['동래읍성','온천천'], },
  '기장':     { station:['기장역'], sights:['기장시장','해동용궁사','오시리아'], shopping:['롯데프리미엄아울렛기장'], },
  '남포동':   { station:['자갈치역','남포역'], sights:['자갈치시장','국제시장','BIFF광장'], shopping:['롯데백화점광복점'], },
  '사직':     { station:['사직역'], sights:['사직야구장'], },
  // ── 인천 ──
  '송도':     { station:['센트럴파크역','인천대입구역'], sights:['센트럴파크','송도컨벤시아'], shopping:['현대프리미엄아울렛송도','트리플스트리트'], },
  '부평':     { station:['부평역','부평시장역'], shopping:['롯데백화점부평','부평지하상가'], },
  '계양':     { station:['계양역'], },
  '연수':     { station:['원인재역'], shopping:['이마트연수'], },
  // ── 대구 ──
  '동성로':   { station:['중앙로역'], sights:['동성로거리','서문시장'], shopping:['롯데백화점대구','대구백화점'], },
  '수성':     { station:['수성구청역','범어역'], apt:['수성못자이'], sights:['수성못'], },
  '칠성동':   { station:['칠성시장역'], sights:['칠성시장'], },
  // ── 대전 ──
  '둔산':     { station:['시청역','탄방역'], shopping:['갤러리아타임월드','롯데백화점대전'], },
  '은행동':   { station:['중앙로역'], sights:['은행동거리','대전중앙시장'], },
  // ── 광주 ──
  '충장로':   { station:['문화전당역'], sights:['충장로','양동시장'], shopping:['롯데백화점광주'], },
  '상무':     { station:['상무역'], shopping:['현대백화점광주'], },
  // ── 울산 ──
  '성남동':   { station:['태화강역'], sights:['성남동먹자골목'], },
  '삼산':     { station:['삼산역'], shopping:['롯데백화점울산'], },
  // ── 경기 ──
  '판교':     { station:['판교역'], shopping:['현대백화점판교','AK플라자판교'], apt:['봇들마을','백현마을'], },
  '분당':     { station:['정자역','미금역','서현역'], shopping:['AK플라자분당','현대백화점판교'], },
  '수원':     { station:['수원역','인계동'], shopping:['롯데백화점수원','AK플라자수원'], },
  '일산':     { station:['일산역','정발산역'], shopping:['킨텍스','라페스타','웨스턴돔'], },
  '평택':     { station:['평택역'], shopping:['이마트평택'], },
  '용인':     { station:['용인역'], sights:['에버랜드'], shopping:['롯데프리미엄아울렛기흥'], },
  '안양':     { station:['안양역','범계역'], shopping:['롯데백화점안양'], },
  '부천':     { station:['부천역','중동역'], shopping:['롯데백화점중동'], },
  '의정부':   { station:['의정부역'], shopping:['롯데백화점의정부'], },
  '하남':     { station:['미사역'], shopping:['스타필드하남'], },
  '파주':     { station:['금촌역'], shopping:['롯데프리미엄아울렛파주'], sights:['헤이리','프리미엄아울렛'], },
  // ── 강원 ──
  '강릉':     { station:['강릉역'], sights:['안목해변','경포해수욕장','오죽헌'], },
  '속초':     { station:['속초'], sights:['속초해수욕장','설악산','청초호'], shopping:['속초관광수산시장'], },
  '춘천':     { station:['춘천역'], sights:['남이섬','의암호','레고랜드'], },
  // ── 제주 ──
  '제주':     { station:['제주공항'], sights:['한라산','성산일출봉','협재해수욕장','올레길','우도'], },
  '제주시':   { station:['제주공항'], sights:['동문시장','제주목관아'], },
  '서귀포':   { sights:['중문해수욕장','천지연폭포','정방폭포'], },
  '애월':     { sights:['애월해안도로','한담해변','곽지해수욕장'], },
  // ── 경남 ──
  '창원':     { station:['창원역','창원중앙역'], shopping:['롯데백화점창원'], },
  '마산':     { station:['마산역'], sights:['마산어시장','3·15의거'], },
  '진주':     { station:['진주역'], sights:['진주성','남강'], shopping:['롯데백화점진주'], },
  '통영':     { sights:['통영케이블카','미륵도','달아공원','통영수산시장'], },
  '거제':     { sights:['거제도','외도','학동흑진주몽돌해변'], },
  // ── 경북 ──
  '경주':     { station:['경주역'], sights:['불국사','첨성대','안압지','보문단지'], },
  '포항':     { station:['포항역'], sights:['호미곶','구룡포'], shopping:['롯데백화점포항'], },
  '안동':     { station:['안동역'], sights:['하회마을','안동찜닭거리'], },
  // ── 전북 ──
  '전주':     { station:['전주역'], sights:['전주한옥마을','남부시장','경기전'], },
  '군산':     { station:['군산역'], sights:['근대화거리','새만금'], },
  // ── 전남 ──
  '여수':     { station:['여수엑스포역'], sights:['여수밤바다','오동도','돌산공원'], },
  '순천':     { station:['순천역'], sights:['순천만국가정원','낙안읍성'], },
  '목포':     { station:['목포역'], sights:['유달산','목포근대역사거리'], },
  // ── 충남 ──
  '천안':     { station:['천안역','천안아산역'], shopping:['갤러리아천안','신세계천안'], },
  '아산':     { station:['온양온천역','아산역'], sights:['현충사'], },
  // ── 충북 ──
  '청주':     { station:['청주역','오송역'], sights:['수암골','무심천'], shopping:['롯데백화점청주'], },
  '충주':     { station:['충주역'], sights:['충주호','탄금대','수안보온천'], },
  '제천':     { station:['제천역'], sights:['청풍호','의림지','월악산'], },
  // ── 충남 추가 ──
  '서산':     { sights:['해미읍성','서산버드랜드','간월도'], },
  '보령':     { station:['보령역'], sights:['대천해수욕장','머드축제','무창포'], },
  '태안':     { sights:['만리포해수욕장','꽃지해수욕장','안면도'], },
  '논산':     { station:['논산역'], sights:['관촉사','논산딸기'], },
  '공주':     { station:['공주역'], sights:['공산성','송산리고분군','무령왕릉'], },
  // ── 경북 추가 ──
  '구미':     { station:['구미역'], shopping:['롯데백화점구미'], },
  '김천':     { station:['김천구미역'], sights:['직지사'], },
  '영주':     { station:['영주역'], sights:['부석사','풍기인삼시장','무섬마을'], },
  '영천':     { station:['영천역'], sights:['보현산천문과학관'], },
  '상주':     { sights:['상주자전거박물관','경천대'], },
  '문경':     { sights:['문경새재','문경레일바이크'], },
  // ── 경남 추가 ──
  '김해':     { station:['김해역'], sights:['김해가야테마파크','봉하마을'], shopping:['롯데프리미엄아울렛김해'], },
  '양산':     { station:['양산역','물금역'], sights:['통도사','에덴밸리'], },
  '밀양':     { station:['밀양역'], sights:['표충사','밀양아리랑'], },
  '사천':     { sights:['사천바다케이블카','실안낙조'], },
  '거창':     { sights:['거창한마당축제','수승대'], },
  // ── 전북 추가 ──
  '익산':     { station:['익산역'], sights:['미륵사지','보석박물관'], },
  '남원':     { station:['남원역'], sights:['광한루','지리산'], },
  '정읍':     { station:['정읍역'], sights:['내장산','정읍사'], },
  '김제':     { sights:['벽골제','지평선축제'], },
  // ── 전남 추가 ──
  '나주':     { station:['나주역'], sights:['나주영산포','금성관'], },
  '광양':     { station:['광양역'], sights:['광양매화마을','백운산'], },
  '담양':     { sights:['죽녹원','메타세쿼이아길','소쇄원'], },
  '해남':     { sights:['땅끝마을','두륜산','대흥사'], },
  '완도':     { sights:['완도타워','보길도','완도수목원'], },
  // ── 강원 추가 ──
  '원주':     { station:['원주역','만종역'], sights:['치악산','소금산출렁다리'], },
  '동해':     { station:['동해역'], sights:['묵호항','천곡천연동굴','추암촛대바위'], },
  '삼척':     { station:['삼척역'], sights:['삼척해상케이블카','이사부사자공원','환선굴'], },
  '양양':     { sights:['서피비치','낙산해수욕장','낙산사'], },
  '평창':     { station:['평창역','진부역'], sights:['대관령','알펜시아','오대산월정사'], },
  '태백':     { station:['태백역'], sights:['태백산','검룡소','황지연못'], },
  '정선':     { station:['정선역'], sights:['정선레일바이크','아라리촌','하이원리조트'], },
  // ── 세종/기타 ──
  '세종':     { sights:['세종호수공원','국립세종도서관','조치원'], },
};

// 전국 지역명 플랫 리스트 (주소 매칭용)
const ALL_REGIONS = [
  ...Object.keys(LANDMARK_DB),
  // 서울 구/동
  '강남구','강동구','강북구','강서구','관악구','광진구','구로구','금천구',
  '노원구','도봉구','동대문구','동작구','마포구','서대문구','서초구','성동구',
  '성북구','송파구','양천구','영등포구','용산구','은평구','종로구','중구','중랑구',
  '압구정','청담','논현','역삼','개포','도곡','수서','위례','방배','신사','한남',
  '신림','봉천','낙성대','낙천','사당','동작','흑석','노량진',
  '합정','망원','연남','마포','공덕','아현','신촌','이대','홍제','연희','북아현',
  '이태원','해방촌','경리단길','한남','동빙고','보광',
  '종로','인사동','익선동','서촌','부암동','평창동','구기동',
  '상암','수색','증산','망원','성산','연남',
  '잠실','석촌','방이','풍납','오금','이천','가락','문정','장지','위례',
  '대치','역삼','선릉','삼성','청담','압구정','신사','논현','개포','일원','수서',
  '천호','길동','명일','강일','고덕','암사',
  '신도림','구로','가산','독산','시흥','대림','도림','영등포','당산','합정',
  // 부산 구/동
  '해운대구','수영구','남구','동구','서구','중구','부산진구','동래구',
  '연제구','북구','사하구','강서구','금정구','기장군',
  '대연동','용호동','경성대','부경대','온천동','장전동','부전동',
  // 인천 구
  '계양구','남동구','동구','부평구','서구','연수구','중구','강화군',
  // 대구 구
  '중구','동구','서구','남구','북구','수성구','달서구','달성군',
  '수성못','범어','만촌','황금','지산','시지','욱수','두류','성서','월성',
  // 대전 구
  '동구','중구','서구','유성구','대덕구',
  '둔산동','갈마동','만년동','월평동','용문동','정림동','탄방동','관저동',
  // 광주 구
  '동구','서구','남구','북구','광산구',
  '충장로','금남로','상무지구','봉선','운암','첨단','수완',
  // 경기 주요 시/구
  '성남시','용인시','수원시','안양시','부천시','광명시','화성시','하남시',
  '남양주시','파주시','김포시','의정부시','구리시','양주시','동두천시','포천시',
  '고양시','일산서구','일산동구','덕양구',
  '분당구','수정구','중원구','판교','정자','미금','서현','이매','야탑','모란',
  '광교','영통','팔달','장안','권선',
  // 강원
  '춘천시','원주시','강릉시','속초시','동해시','태백시','삼척시',
  '홍천군','횡성군','영월군','평창군','정선군','철원군','화천군','양구군','인제군','고성군','양양군',
  // 충청
  '청주시','충주시','제천시','천안시','공주시','보령시','아산시','서산시','논산시','계룡시','당진시',
  '태안군','예산군','홍성군','부여군','서천군','옥천군','영동군','증평군','진천군','괴산군','단양군',
  // 전라
  '전주시','군산시','익산시','정읍시','남원시','김제시',
  '완주군','무주군','진안군','장수군','임실군','순창군','고창군','부안군',
  '목포시','여수시','순천시','나주시','광양시',
  '담양군','해남군','완도군','영암군','진도군','무안군','강진군','장흥군','보성군',
  // 경상
  '포항시','경주시','김천시','안동시','구미시','영주시','영천시','상주시','문경시','경산시',
  '창원시','진주시','통영시','사천시','김해시','밀양시','거제시','양산시',
  '거창군','합천군','함양군','산청군','하동군','남해군','고성군',
  '마산','진해',
  // 제주
  '제주시','서귀포시',
];

// ══════════════════════════════════════════════════════════
// ★ 지역명 필터 — GPS 없는 서버에서 전국구 키워드 사전 차단 ★
// ══════════════════════════════════════════════════════════

// ALL_REGIONS + LANDMARK_DB 역세권/랜드마크 → 2글자 이상만 정규식 토큰화
const _regionTokens = new Set();
ALL_REGIONS.forEach(r => { if (r && r.length >= 2) _regionTokens.add(r.replace(/시$|구$|군$|동$/, '').length >= 2 ? r.replace(/시$|구$|군$|동$/, '') : r); _regionTokens.add(r); });
Object.keys(LANDMARK_DB).forEach(k => _regionTokens.add(k));
Object.values(LANDMARK_DB).forEach(v => {
  if (v.station) v.station.forEach(s => _regionTokens.add(s.replace(/역$/, '')));
  if (v.sights) v.sights.forEach(s => _regionTokens.add(s));
  if (v.shopping) v.shopping.forEach(s => _regionTokens.add(s));
});
// 짧은 토큰(1글자) 제거, 중복 제거 후 길이 내림차순 정렬 (최장 우선 매칭)
const _regionList = [..._regionTokens].filter(t => t && t.length >= 2).sort((a,b) => b.length - a.length);
const _regionRe = new RegExp(_regionList.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

/**
 * 키워드에 지역 컨텍스트(지역명/역/랜드마크) 또는 업체명이 포함되어 있는지 확인
 * @returns {boolean} true면 검색 실행, false면 스킵
 */
function hasLocationContext(keyword, bizName) {
  if (!keyword) return false;
  // 1) 지역명/역/랜드마크 포함 여부
  if (_regionRe.test(keyword)) return true;
  // 2) 업체명 포함 여부 (브랜드 키워드)
  if (bizName && bizName.length >= 2) {
    const nb = bizName.replace(/\s+/g, '').toLowerCase();
    const nk = keyword.replace(/\s+/g, '').toLowerCase();
    if (nk.includes(nb) || nb.includes(nk.replace(/[가-힣]{1,2}(맛집|추천|후기|인기|순위|예약|가격)/, ''))) return true;
  }
  return false;
}

console.log(`[INIT] 지역 토큰 ${_regionList.length}개 로드 (지역명 필터 활성화)`);

// ══════════════════════════════════════════════════════════
// STEP 1 : 플레이스 크롤링
// ══════════════════════════════════════════════════════════
async function deepCrawl(placeId) {
  const info = { placeId, name:'', category:'', catCode:'', address:'', menus:[], tags:[], reviewTags:[] };
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
    await page.setExtraHTTPHeaders({ 'Accept-Language':'ko-KR,ko;q=0.9' });

    const net = { menus:[], address:'', category:'' };
    page.on('response', async res => {
      try {
        const url = res.url();
        if (!url.includes('naver')) return;
        if (!(res.headers()['content-type']||'').includes('json')) return;
        const j = await res.json().catch(()=>null);
        if (!j) return;
        const s = JSON.stringify(j);
        if (!net.address){ const m=s.match(/"roadAddress"\s*:\s*"([^"]{5,80})"/); if(m) net.address=m[1]; }
        if (!net.category){ const m=s.match(/"(?:categoryName|category)"\s*:\s*"([^"]{2,30})"/); if(m) net.category=m[1]; }
        // menuName/itemName 등 엄격한 필드 + alt 필드 (이미지 alt에 메뉴명 있음)
        // 엄격한 메뉴 전용 필드만 (alt/name/label 제외 — 사진라벨/유저명 오염방지)
        const mp = [...s.matchAll(/"(?:menuName|itemName|serviceName|treatmentName|productName|foodName)"\s*:\s*"([^"]{1,22})"/g)]
          .map(m=>m[1].trim())
          .filter(m=>/[가-힣]/.test(m) && m.length>=1 && m.length<=22);
        if (mp.length) net.menus = [...new Set([...net.menus,...mp])].slice(0,80);
      } catch(e){}
    });

    // 플레이스 타입 자동 탐지
    let placeType = 'place';
    for (const t of ['restaurant','beauty','hospital','place']) {
      try {
        await page.goto(`https://m.place.naver.com/${t}/${placeId}/home`,{waitUntil:'networkidle0',timeout:15000});
        await new Promise(r=>setTimeout(r,2500));
        const len = await page.evaluate(()=>(document.body?.innerText||'').length);
        if (len > 300) { placeType=t; console.log('[CRAWL] type:'+t); break; }
      } catch(e){}
    }

    const homeData = await page.evaluate(function(){
      function og(k){ var el=document.querySelector('meta[property="og:'+k+'"]'); return el?el.getAttribute('content')||'':''; }
      var ld={};
      document.querySelectorAll('script[type="application/ld+json"]').forEach(function(sc){
        try{ var p=JSON.parse(sc.textContent); ld=p['@graph']?p['@graph'][0]:p; }catch(e){}
      });
      var sAddr='',sCat='',sMenus=new Set();
      document.querySelectorAll('script:not([src])').forEach(function(sc){
        var t=sc.textContent||'';
        if(!sAddr){var m=t.match(/"roadAddress"\s*:\s*"([^"]{5,80})"/);if(m)sAddr=m[1];}
        if(!sCat){var m=t.match(/"(?:categoryName|category)"\s*:\s*"([^"]{2,30})"/);if(m)sCat=m[1];}
        Array.from(t.matchAll(/"(?:menuName|itemName|serviceName|treatmentName)"\s*:\s*"([가-힣a-zA-Z·\s][^"]{1,18})"/g))
          .forEach(function(m){ if(/[가-힣]/.test(m[1])&&m[1].trim().length>=2) sMenus.add(m[1].trim()); });
      });
      var tagSet=new Set();
      ['span[class*="tag"]','span[class*="Tag"]','button[class*="filter"]','span[class*="keyword"]','span[class*="chip"]'].forEach(function(sel){
        document.querySelectorAll(sel).forEach(function(el){
          var t=(el.textContent||'').trim();
          if(t&&t.length>=2&&t.length<=14&&/[가-힣]/.test(t)) tagSet.add(t);
        });
      });
      var body=(document.body||{}).innerText||'';
      var priceItems=Array.from(body.matchAll(/([가-힣a-zA-Z·\s]{2,14})\n[\d,]+원/g)).map(m=>m[1].trim());
      var servesCuisine=Array.isArray((ld||{}).servesCuisine)?ld.servesCuisine:[];
      return {
        name:((og('title')||'').split(/[:\-|·]/)[0]||'').trim()||(ld||{}).name||'',
        address:((ld||{}).address||{}).streetAddress||sAddr||'',
        category:(ld||{})['@type']||sCat||'',
        scriptMenus:[...sMenus].slice(0,60),
        priceItems:[...new Set(priceItems)].slice(0,30),
        tags:[...tagSet].slice(0,30),
        servesCuisine:servesCuisine.slice(0,10),
        body:body.slice(0,15000),
      };
    });

    // ── 메뉴/서비스 크롤링 (전업종 공통) ─────────────────────
    const menuTabItems = new Set();

    // XHR 인터셉트 (menuName/itemName/treatmentName/serviceName 전용)
    const menuJsonRaws = [];
    const menuPending  = [];
    const onMenuResp = res => {
      try {
        if (!(res.headers()['content-type']||'').includes('json')) return;
        if (!res.url().includes('naver')) return;
        const p = res.text().then(t => { if (t && t.length > 50) menuJsonRaws.push(t); }).catch(()=>{});
        menuPending.push(p);
      } catch(e){}
    };
    page.on('response', onMenuResp);

    // /menu 탭 로드
    for (const murl of [
      `https://m.place.naver.com/${placeType}/${placeId}/menu`,
      `https://m.place.naver.com/place/${placeId}/menu`,
    ]) {
      try {
        await page.goto(murl, { waitUntil: 'networkidle0', timeout: 20000 });
        const l = await page.evaluate(() => (document.body||{}).innerText?.length || 0);
        console.log(`[MENU] 초기 len=${l}`);
        if (l > 100) break;
      } catch(e) {}
    }

    // ★ "펼쳐서 더보기" — 메뉴 목록 전체 펼치기
    // 주의: 사진 더보기(메뉴판)가 아닌 텍스트 목록 더보기만 클릭
    const expandCount = await page.evaluate(function() {
      var count = 0;
      var all = Array.from(document.querySelectorAll('a, button, span'));
      all.forEach(function(el) {
        var txt = (el.textContent || '').trim();
        // "펼쳐서 더보기" 또는 "전체 메뉴 보기" 정확히 일치
        if (txt === '펼쳐서 더보기' || txt === '전체메뉴보기' || txt === '전체 메뉴 보기') {
          try { el.click(); count++; } catch(e){}
        }
      });
      return count;
    });
    if (expandCount > 0) {
      console.log(`[MENU] 펼쳐서더보기 ${expandCount}회 클릭`);
      await new Promise(r => setTimeout(r, 1500));
    }

    page.off('response', onMenuResp);
    await Promise.allSettled(menuPending);

    const finalLen = await page.evaluate(() => (document.body||{}).innerText?.length || 0);
    console.log(`[MENU] 최종 len=${finalLen}`);

    // ① DOM innerText — 가격 기준 역추적 (핵심, 전업종 공통)
    // 네이버 메뉴탭 구조: 메뉴명 → (설명) → 가격원
    const domMenus = await page.evaluate(function() {
      var res = new Set();
      var body = (document.body || {}).innerText || '';
      var lines = body.split('\n').map(function(l){ return l.trim(); }).filter(Boolean);
      for (var i = 1; i < lines.length; i++) {
        if (!/^[\d,]{3,9}원/.test(lines[i])) continue;
        // 가격 앞 최대 5줄 역추적 — 가장 짧고 한글인 줄이 메뉴명
        for (var back = 1; back <= 5 && i - back >= 0; back++) {
          var c = lines[i - back];
          if (c.length >= 1 && c.length <= 22 &&
              /[가-힣]/.test(c) &&
              !/^\d/.test(c) &&
              !/원$/.test(c) &&
              c.split(/\s+/).length <= 4) {
            res.add(c);
            break;
          }
        }
      }
      return [...res].slice(0, 100);
    }).catch(function(){ return []; });

    domMenus.forEach(m => menuTabItems.add(m));
    console.log(`[MENU-DOM] ${domMenus.length}개: ${domMenus.slice(0,10).join(', ')}`);

    // ② XHR JSON — 메뉴 전용 필드명만 (alt/name/label 제외)
    const MENU_FIELDS = ['menuName','itemName','treatmentName','serviceName','productName','foodName'];
    for (const raw of menuJsonRaws) {
      for (const field of MENU_FIELDS) {
        const re = new RegExp('"' + field + '"\\s*:\\s*"([^"]{1,25})"', 'g');
        let m;
        while ((m = re.exec(raw)) !== null) {
          const v = m[1].trim();
          if (/[가-힣]/.test(v) && v.length >= 1 && v.length <= 22) menuTabItems.add(v);
        }
      }
    }
    if (menuJsonRaws.length > 0)
      console.log(`[MENU-XHR] ${menuJsonRaws.length}개 json → 누적 ${menuTabItems.size}개`);

    // ③ 홈탭 XHR (net.menus) — menuName/itemName만 수집된 것
    net.menus.forEach(m => menuTabItems.add(m));

    console.log(`[MENU] 최종 ${menuTabItems.size}개: ${[...menuTabItems].slice(0,20).join(', ')}`);

    // ── 리뷰 태그 ──
    try {
      await page.goto(`https://m.place.naver.com/place/${placeId}/review/visitor`,{waitUntil:'networkidle0',timeout:12000});
      await new Promise(r=>setTimeout(r,2000));
      const rev = await page.evaluate(function(){
        var ts=new Set();
        ['span[class*="filter"]','button[class*="filter"]','span[class*="tag"]','span[class*="Tag"]'].forEach(function(sel){
          document.querySelectorAll(sel).forEach(function(el){
            var t=((el.textContent||'').trim().replace(/\d+/g,'')||'').trim();
            if(t&&t.length>=2&&t.length<=14&&/[가-힣]/.test(t)) ts.add(t);
          });
        });
        return [...ts].slice(0,25);
      });
      info.reviewTags = rev;
    } catch(e){}

    // ── 데이터 병합 ──
    info.name    = homeData.name || '';
    info.address = net.address   || homeData.address || '';
    const rawCat = net.category  || homeData.category || '';
    info.category = /^[가-힣]/.test(rawCat) ? rawCat : '';

    // 메뉴/서비스명 필터 — 리뷰 감상문·어미형 완전 차단
    function isRealMenu(m) {
      if (!m || typeof m !== 'string') return false;
      const t = m.trim();
      if (!/[가-힣]/.test(t)) return false;
      // 1글자 한국어 메뉴 허용 (회, 국, 탕, 면 등 실제 메뉴 가능)
      if (t.length < 1 || t.length > 16) return false;
      // 1글자는 한국어 음식 단어만 허용
      if (t.length === 1) {
        const oneCharMenus = new Set(['회','국','탕','면','죽','밥','찜','전','파','술','차','떡','적','구이']);
        return oneCharMenus.has(t);
      }
      // ① 어미형 리뷰 감상문 차단 ("인테리어가 멋져요", "매장이 넓어요" 등)
      if (/어요$|아요$|네요$|이에요$|래요$|죠$|해요$|있어$|없어$|좋아$|해$/.test(t)) return false;
      // ② 조사+형용사 패턴 차단 ("~이/가 ~하다" 구조)
      if (/[이가은는을를]/.test(t) && /[멋|넓|깔|싱|신|친|따|맛|좋]/.test(t)) return false;
      // ③ 4어절 이상 차단
      if (t.split(/\s+/).length >= 4) return false;
      // ④ 금지어
      const bad = ['이미지','보기','구성','이야기','정성','소개','후기','리뷰','이용',
        '오픈','안내','공지','예약','대기','포장','배달','주문','영업','전화','문의',
        '사장님','사진','별점','평점','매장','인테리어','서비스','분위기','주차','웨이팅',
        '살린','담은','곁들인','만든','가득','담긴','나와요','있어요','없어요',
        '해요','촉촉','부드','알차','청결','신선'];
      if (bad.some(w => t.includes(w))) return false;
      // 괄호 허용 — "냉국수(여름 한정)" 같은 메뉴명 유효
      // if (/[()（）\[\]【】]/.test(t)) return false;
      return true;
    }
    // 리뷰 태그도 동일 필터 적용 (검색 가능한 것만)
    function isSearchableTag(tag) {
      if (!tag || typeof tag !== 'string') return false;
      const t = tag.trim();
      if (t.length < 2 || t.length > 14 || !/[가-힣]/.test(t)) return false;
      // 어미형 감상문 차단
      if (/어요$|아요$|네요$|이에요$|래요$|죠$|해요$|있어$|없어$/.test(t)) return false;
      if (/[이가은는을를]/.test(t) && t.includes('요')) return false;
      return true;
    }
    // ── 메뉴 병합: 신뢰할 수 있는 소스만 사용 ──────────────
    // ✅ menuTabItems : /menu 탭 직접 스크래핑 (가장 정확)
    // ✅ net.menus    : XHR JSON의 menuName 필드 (API 직접 응답)
    // ❌ scriptMenus  : 스크립트 전체 긁기 → 인접업체/공통 메뉴 오염
    // ❌ priceItems   : 본문 가격 패턴 → 본문 노이즈 혼입
    // ❌ servesCuisine: ld+json 카테고리 → 실제 메뉴 아님
    // 괄호 내용 제거: "냉국수(여름 한정)" → "냉국수", "젤네일(하드)" → "젤네일"
    // ★ 괄호 완벽 제거: 소괄호(), 대괄호[], 중괄호{}, 전각괄호（）【】 + 특수문자
    const stripParens = m => m
      .replace(/\s*[\(（][^)）]*[\)）]/g, '')   // 소괄호
      .replace(/\s*[\[【][^\]】]*[\]】]/g, '')   // 대괄호
      .replace(/\s*\{[^}]*\}/g, '')             // 중괄호
      .replace(/[★☆●○■□▶▷※~·…]+/g, '')        // 특수기호
      .replace(/\s+/g, ' ').trim();
    // ★ 잡동사니 메뉴 블랙리스트 (검색 가치 0인 단어)
    const MENU_STOPWORDS = new Set([
      // 사이드/음료
      '공기밥','쌀밥','잡곡밥','흰밥','계란후라이','반찬','밑반찬','셀프반찬',
      '음료수','음료','콜라','사이다','스프라이트','환타','생수','물','얼음',
      '소주','맥주','막걸리','와인','하이볼','소맥','음료선택',
      // 공통 부가서비스
      '상담','예약','리터치','추가','변경','연장','수정','취소','할인','이벤트',
      '앞머리','뒷머리','부분','전체','기본','스페셜','프리미엄','디럭스','VIP',
      // 무의미 일반 단어
      '세트','세트메뉴','1인분','2인분','3인분','4인분','대','중','소','곱배기',
      '보통','기본','사이즈','업','추가금','토핑','소스','양념','간장','된장',
      '포장','테이크아웃','배달','매장','방문','전화',
      // 생활용품/브랜드
      '다이소','올리브영','편의점','마트','슈퍼',
      // 기타 노이즈
      '메뉴판','가격표','영수증','계산','카드','현금','선결제',
    ]);
    const isNotStopword = m => !MENU_STOPWORDS.has(m.trim());

    const allMenus = [...new Set([
      ...[...menuTabItems].map(stripParens),
      ...net.menus.map(stripParens),
    ])].filter(m => m.length >= 1).filter(isNotStopword).filter(isRealMenu).slice(0, 60);
    info.menus = allMenus;
    info.tags  = homeData.tags || [];
    // 리뷰 태그 필터링 (isSearchableTag 적용)
    info.reviewTags = (info.reviewTags||[]).filter(isSearchableTag);

    // 주소 보완
    if (!info.address) {
      const body = homeData.body || '';
      for (const p of [
        /([가-힣]{2,4}시\s*[가-힣]{2,4}구[가-힣\s\d\-\.]+(?:로|길)\s*\d+)/,
        /([가-힣]{2,4}시\s*[가-힣]{2,4}구\s*[가-힣]{2,4}동)/,
        /([가-힣]{2,4}구\s*[가-힣]{2,4}동)/,
      ]) { const m=body.match(p); if(m){info.address=m[1].trim();break;} }
    }

    // ── 업종코드 감지 (핵심) ──
    info.catCode = detectCatCode(info);

    // 메뉴 폴백: menuTab/API 결과가 3개 미만일 때만, 리뷰태그에서 검증된 것만 보완
    if (info.menus.length < 3) {
      const hints  = SERVICE_HINT[info.catCode] || [];
      // 리뷰태그에 실제로 등장한 힌트만 (본문 body 검색 제거 - 오염 위험)
      const reviewTagStr = info.reviewTags.join(' ');
      const relevant = hints.filter(h => reviewTagStr.includes(h));
      if (relevant.length > 0) {
        info.menus = [...new Set([...info.menus, ...relevant])].slice(0, 30);
      }
    }

    console.log('══════════════════════════');
    console.log('[OK] 업장명:', info.name);
    console.log('[OK] 업종:', info.category, '→ 코드:', info.catCode);
    console.log('[OK] 주소:', (info.address||'').slice(0,50));
    console.log('[OK] 메뉴/서비스('+info.menus.length+'개):', info.menus.slice(0,8).join(', '));
    console.log('[OK] 리뷰태그:', info.reviewTags.slice(0,6).join(', '));
    console.log('══════════════════════════');

  } catch(e) { console.error('크롤 오류:', e.message); }
  finally { await safeClose(page); }
  return info;
}

// ── 업종코드 감지 로직 ──
function detectCatCode(info) {
  const { name, category, address, tags, reviewTags, menus } = info;
  const haystack = [name, category, ...(tags||[]), ...(reviewTags||[]), ...(menus||[])].join(' ');

  // 1순위: 정확한 카테고리명 직접 매핑
  for (const [catCode, keywords] of Object.entries(CAT_MAP)) {
    for (const kw of keywords) {
      if (category && category.includes(kw)) return catCode;
    }
  }
  // 2순위: 업장명/태그/메뉴 포함 여부
  for (const [catCode, keywords] of Object.entries(CAT_MAP)) {
    for (const kw of keywords) {
      if (kw.length >= 2 && haystack.includes(kw)) return catCode;
    }
  }
  // 3순위: 주소 제거 후 재탐색 (지역명과 혼동 방지)
  return 'food'; // 기본값
}


// ══════════════════════════════════════════════════════════
// STEP 2 : ★★★ MASS KEYWORD BLASTER v12 ★★★
// ──────────────────────────────────────────────────────────
// 핵심 원칙:
//  1. 업장 실제 메뉴·리뷰태그·업장명만 사용
//  2. 지역 × 실제서비스 × 의도어 곱집합을 체계적으로 완전소진
//  3. 복합 메뉴 합성 (차돌박이+칼국수→차돌박이칼국수)
//  4. 붙여쓰기 변형 (광안리칼국수맛집 / 광안리 칼국수 맛집)
//  5. 500라운드까지 확장 — 키워드 고갈 거의 불가
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// ★★★ 업종별 하드 블록 (Category Siloing) ★★★
// 해당 catCode에서 절대 사용 불가능한 단어 목록
// 음식/카페 전용어가 병원/학원/네일샵에 침투하는 것을 원천 차단
// ══════════════════════════════════════════════════════════
const FOOD_CAFE_ONLY = [
  '맛집','맛있는곳','맛있는집','맛잇는집','먹을곳','먹을만한곳','갈만한곳',
  '핫플','숨은맛집','현지인맛집','로컬맛집','인생맛집','맛집추천','추천맛집',
  '야식','혼밥','혼술','회식','데이트','브런치','점심특선',
  '가족외식','가족모임','모임하기좋은','회식자리',
  '분위기좋은','뷰좋은','오션뷰','감성','인스타',
  '국수집','밥집','한식집','식당','음식점','한식당',
  '가성비','저렴한','싼',
];

const CAT_BLOCKED = {
  // 의료 계열: 맛집/카페/음식 단어 전면 차단
  medical_skin:     FOOD_CAFE_ONLY,
  medical_dental:   FOOD_CAFE_ONLY,
  medical_korean:   FOOD_CAFE_ONLY,
  medical_ortho:    FOOD_CAFE_ONLY,
  medical_eye:      FOOD_CAFE_ONLY,
  medical_ent:      FOOD_CAFE_ONLY,
  medical_internal: FOOD_CAFE_ONLY,
  medical_ob:       FOOD_CAFE_ONLY,
  medical_gen:      FOOD_CAFE_ONLY,
  // 뷰티 계열: 음식 전용어 차단
  beauty_hair: [...FOOD_CAFE_ONLY, '맛있는','먹을','야식','혼밥','브런치'],
  beauty_nail: [...FOOD_CAFE_ONLY, '맛있는','먹을','야식','혼밥','브런치'],
  beauty_skin: [...FOOD_CAFE_ONLY, '맛있는','먹을','야식','혼밥','브런치'],
  // 교육 계열
  academy: [...FOOD_CAFE_ONLY, '시술','치료','진료','수술','성형','필러','보톡스'],
  // 인테리어/기타 전문직
  interior:  [...FOOD_CAFE_ONLY, '시술','치료','진료','수술'],
  car:       [...FOOD_CAFE_ONLY, '시술','치료','진료'],
  pet:       [...FOOD_CAFE_ONLY.filter(w => !['가성비','저렴한'].includes(w))],
  // 음식/카페는 의료 전용어 차단
  food: ['시술','치료','진료','수술','성형','필러','보톡스','임플란트','교정','스케일링',
         '수능','입시','과외','학원','인테리어','시공','도배','타일'],
  cafe: ['시술','치료','진료','수술','성형','필러','보톡스','임플란트','교정',
         '수능','입시','과외','학원','인테리어','시공'],
};

// 글로벌 키워드 블랙리스트 (모든 업종 공통 — 검색 가치 0)
const GLOBAL_KW_STOPWORDS = new Set([
  '공기밥','쌀밥','음료수','콜라','사이다','생수','소주','맥주','막걸리',
  '상담','리터치','추가','변경','포장','배달','전화','문의','계산','카드',
  '다이소','올리브영','편의점','마트','영수증','가격표','메뉴판',
  '세트메뉴','1인분','2인분','곱배기','토핑','소스','앞머리',
]);

class InfiniteKeywordStream {
  constructor(info) {
    const { name, category, address, menus, tags, reviewTags, catCode } = info;
    this.tried  = new Set();
    this.buffer = [];
    this.round  = 0;

    const cfg = CAT_CONFIG[catCode] || DEFAULT_CONFIG;

    // ── 지역 토큰 분리 추출 ──
    const guM   = address && address.match(/([가-힣]{2,4}구)/);
    const dongM = address && address.match(/([가-힣]{2,4}동)/);
    const roM   = address && address.match(/([가-힣]{2,8}(?:로|길))/);
    const cityM = address && address.match(/([가-힣]{2,6}(?:시|군))/);
    const metroM= address && address.match(/(서울|부산|대구|인천|광주|대전|울산|세종|수원|창원|고양|용인|성남|안양|안산|청주|전주|천안)/);

    // ── 시 계열 ──
    const cityBare = [];
    const citySi   = [];
    const METRO_SUFFIX = {
      '서울':'서울특별시','부산':'부산광역시','대구':'대구광역시',
      '인천':'인천광역시','광주':'광주광역시','대전':'대전광역시',
      '울산':'울산광역시','세종':'세종특별자치시'
    };
    const GENERAL_SI = new Set(['수원','창원','고양','용인','성남','안양','안산','청주','전주','천안']);

    if (metroM) {
      const bare = metroM[1];
      cityBare.push(bare);
      citySi.push(bare + '시');
      const full = METRO_SUFFIX[bare];
      if (full && full !== bare + '시') citySi.push(full);
    }
    if (cityM) {
      const full = cityM[1];
      const bare = full.replace(/광역시$/,'').replace(/특별시$/,'')
                       .replace(/특별자치시$/,'').replace(/특별자치도$/,'')
                       .replace(/시$/,'').replace(/군$/,'');
      if (bare.length >= 2) {
        if (!cityBare.includes(bare)) cityBare.push(bare);
        const si = bare + '시';
        if (!citySi.includes(si)) citySi.push(si);
        if (full !== si && !citySi.includes(full)) citySi.push(full);
      } else {
        if (!citySi.includes(full)) citySi.push(full);
      }
    }

    const withKorea = [...cityBare, ...citySi].map(c => `대한민국 ${c}`);
    const cityTokens = [...new Set([...cityBare, ...citySi])];
    const cityAllTokens = [...new Set([...cityBare, ...citySi, ...withKorea])];

    // ── 구 계열 ──
    const guTokens = [];
    if (guM) {
      guTokens.push(guM[1]);
      const bare = guM[1].replace(/구$/, '');
      if (bare.length >= 2) guTokens.push(bare);
    }

    // ── 동 계열 ──
    const dongTokens = [];
    if (dongM) {
      dongTokens.push(dongM[1]);
      const bare = dongM[1].replace(/동$/, '');
      if (bare.length >= 2 && bare !== dongM[1]) dongTokens.push(bare);
    }

    // ── 랜드마크 ──
    const lmTokens = [];
    for (const r of Object.keys(LANDMARK_DB)) {
      if ((address && address.includes(r)) || (name && name.includes(r))) {
        lmTokens.push(r);
      }
    }
    const lmDb = { station:[], sights:[], shopping:[] };
    [...guTokens, ...dongTokens, ...lmTokens].forEach(r => {
      const db = LANDMARK_DB[r]; if (!db) return;
      if (db.station)  lmDb.station.push(...db.station);
      if (db.sights)   lmDb.sights.push(...db.sights);
      if (db.shopping) lmDb.shopping.push(...db.shopping);
    });
    this.stations = [...new Set(lmDb.station)].slice(0, 12);
    this.sights   = [...new Set(lmDb.sights)].slice(0, 10);
    this.shopping = [...new Set(lmDb.shopping)].slice(0, 8);
    this.allLMs   = [...this.stations, ...this.sights, ...this.shopping, ...lmTokens];

    // ── 지역 prefix 조합 생성 (v12: 더 공격적) ──
    const prefixSet = new Set();
    const C  = cityAllTokens;
    const G  = guTokens;
    const D  = dongTokens;
    const LM = lmTokens;
    const ST = this.stations.slice(0, 6);
    const SI = this.sights.slice(0, 5);

    // ① 단일
    [...C, ...G, ...D, ...LM, ...ST, ...SI].forEach(t => prefixSet.add(t));

    // ② 이중
    [
      [C, G], [C, D], [C, LM], [C, ST], [C, SI],
      [G, D], [G, LM], [G, ST], [G, SI],
      [D, LM], [D, ST], [LM, SI], [LM, ST],
    ].forEach(([A, B]) =>
      A.forEach(a => B.forEach(b => { if(a!==b) prefixSet.add(`${a} ${b}`); }))
    );

    // ③ 삼중
    [
      [C, G, D], [C, G, LM], [C, G, ST], [C, G, SI],
      [C, D, LM], [C, D, ST], [C, D, SI],
      [G, D, LM], [G, D, ST], [G, D, SI],
      [C, LM, ST], [C, LM, SI], [G, LM, ST], [G, LM, SI],
    ].forEach(([A, B, Cv]) =>
      A.forEach(a => B.forEach(b => Cv.forEach(c => {
        if (a!==b && b!==c && a!==c) prefixSet.add(`${a} ${b} ${c}`);
      })))
    );

    // ④ 사중
    if (G.length && D.length && LM.length) {
      C.forEach(c => G.forEach(g => D.forEach(d => LM.forEach(l => {
        const p = `${c} ${g} ${d} ${l}`;
        if (p.length <= 35) prefixSet.add(p);
      }))));
    }

    // ⑤ v12 신규: 랜드마크 체인 (벡스코 마린시티 요트)
    if (LM.length >= 2) {
      for (let i = 0; i < LM.length; i++) {
        for (let j = i+1; j < LM.length; j++) {
          prefixSet.add(`${LM[i]} ${LM[j]}`);
          prefixSet.add(`${LM[j]} ${LM[i]}`);
          C.slice(0,2).forEach(c => {
            prefixSet.add(`${c} ${LM[i]} ${LM[j]}`);
          });
        }
      }
    }

    // 길이 35자 이하, 토큰수→길이 순 정렬
    this.regionPrefixes = [...prefixSet]
      .filter(p => p.length >= 2 && p.length <= 35)
      .sort((a, b) => a.split(' ').length - b.split(' ').length || a.length - b.length);

    this.regions = [...new Set([...G, ...D, ...cityTokens])].filter(r => r.length >= 2);

    console.log(`[v12 스트림] 지역prefix ${this.regionPrefixes.length}개:`, this.regionPrefixes.slice(0,10).join(' | '));

    // ── 실제 업장 서비스 ──
    const hints = (SERVICE_HINT[catCode] || []).slice(0, 10);
    const realMenus = (menus || []).filter(Boolean).slice(0, 40);
    const realTags  = (reviewTags || []).filter(Boolean).slice(0, 25);

    const bodyText = [...realMenus, ...realTags, category||'', name||''].join(' ');
    const safeHints = hints.filter(h => bodyText.includes(h)).slice(0, 8);
    this.coreServices = realMenus.length >= 2
      ? realMenus.slice(0, 25)
      : [...new Set([...realMenus, ...safeHints])].slice(0, 25);

    this.extServices = [...new Set([
      ...realMenus,
      ...realTags.slice(0, 15),
      ...safeHints,
    ])].filter(Boolean).slice(0, 45);

    // ── v12 핵심: 복합 메뉴 합성어 생성 ──
    // 예: 차돌박이 + 칼국수 → 차돌박이칼국수, 차돌박이 칼국수
    this.compoundMenus = [];
    const menuPool = [...new Set([...this.coreServices, ...this.extServices.slice(0, 20)])];
    // 수식어 성 메뉴 (차돌박이, 얼큰, 들깨, 매운 등)
    const MENU_MODIFIERS = ['차돌박이','얼큰','매운','들깨','매콤','시원한','뜨끈한','특제','수제','왕','미니','전통','옛날','원조','생','냉','물','비빔','육개장'];
    // 기본 메뉴 (칼국수, 수제비, 비빔밥 등)
    const BASE_MENUS = ['칼국수','수제비','국수','비빔밥','비빔국수','냉국수','주먹밥','볶음밥','덮밥','전골','찌개','부추전'];

    // 실제 메뉴에서 수식어와 기본메뉴 추출
    const foundMods = menuPool.filter(m => MENU_MODIFIERS.some(mod => m.includes(mod)));
    const foundBases = menuPool.filter(m => BASE_MENUS.some(base => m.includes(base)));

    // 수식어 추출
    const extractedMods = new Set();
    menuPool.forEach(m => {
      MENU_MODIFIERS.forEach(mod => { if (m.includes(mod)) extractedMods.add(mod); });
    });
    // 기본 메뉴 추출
    const extractedBases = new Set();
    menuPool.forEach(m => {
      BASE_MENUS.forEach(base => { if (m.includes(base)) extractedBases.add(base); });
    });
    // 메뉴에 없더라도 카테고리에서 추출
    if (category) {
      MENU_MODIFIERS.forEach(mod => { if (category.includes(mod)) extractedMods.add(mod); });
      BASE_MENUS.forEach(base => { if (category.includes(base)) extractedBases.add(base); });
    }

    // 합성어 생성
    const compSet = new Set();
    [...extractedMods].forEach(mod => {
      [...extractedBases].forEach(base => {
        if (mod !== base) {
          compSet.add(`${mod}${base}`);    // 차돌박이칼국수
          compSet.add(`${mod} ${base}`);   // 차돌박이 칼국수
        }
      });
    });
    // 메뉴끼리 합성 (칼국수 + 수제비 → 칼제비 같은건 직접 넣고, 일반 조합)
    const topMenus = this.coreServices.slice(0, 8);
    for (let i = 0; i < topMenus.length; i++) {
      for (let j = i+1; j < topMenus.length; j++) {
        if (topMenus[i].length + topMenus[j].length <= 10) {
          compSet.add(`${topMenus[i]} ${topMenus[j]}`);
        }
      }
    }
    this.compoundMenus = [...compSet];
    console.log(`[v12] 복합메뉴 ${this.compoundMenus.length}개:`, this.compoundMenus.slice(0,8).join(', '));

    // ── v12 핵심: 업종별 장소 접미어 ──
    // 맛집 외에 국수집, 한식집, 밥집 등 장소유형 접미어
    this.placeSuffixes = ['맛집','추천','맛있는곳','맛있는집','맛잇는집','유명한곳',
      '잘하는곳','인기맛집','핫플','가성비','현지인맛집','후기좋은',
      '인기','유명','잘하는','괜찮은곳','가볼만한곳','좋은곳','어디',
      '추천 맛집','맛집 추천','인기 맛집','숨은 맛집','현지인 맛집','현지인 추천'];

    // 업종 특화 장소어 (음식점이면 국수집/식당/밥집 등)
    if (catCode === 'food') {
      // 카테고리에서 장소어 추출
      const catWords = (category||'').split(/\s+/);
      const placeWords = ['집','점','관','당','원'];
      catWords.forEach(cw => {
        if (cw.length >= 2) this.placeSuffixes.push(cw);
      });
      // 메뉴 기반 장소어
      if (extractedBases.has('국수') || extractedBases.has('칼국수')) {
        this.placeSuffixes.push('국수집','칼국수집','국수맛집');
      }
      if (extractedBases.has('수제비')) this.placeSuffixes.push('수제비집','수제비맛집');
      if (extractedBases.has('비빔밥')) this.placeSuffixes.push('비빔밥집','비빔밥맛집');
      this.placeSuffixes.push('식당','음식점','밥집','한식집','한식당','한정식');
    }
    this.placeSuffixes = [...new Set(this.placeSuffixes)];

    this.reviewTags = realTags;
    this.name       = name;
    this.category   = category;
    this.catCode    = catCode;
    this.roadName   = roM ? roM[1] : null;

    // 의도어 슬롯
    this.suffix  = cfg.suffix  || [];
    this.intents = cfg.intents || [];
    this.sits    = cfg.sits    || [];
    this.mods    = cfg.mods    || [];
    this.alone   = cfg.alone   || [];

    // 저장
    this.cityBare = cityBare;
    this.citySi = citySi;
    this.cityTokens = cityTokens;
    this.guTokens = guTokens;
    this.dongTokens = dongTokens;
    this.lmTokens = lmTokens;

    console.log(`[v12 스트림] 지역: ${this.regions.join(', ')}`);
    console.log(`[v12 스트림] 핵심서비스 ${this.coreServices.length}개: ${this.coreServices.slice(0,5).join(', ')}`);
    console.log(`[v12 스트림] 장소접미어 ${this.placeSuffixes.length}개 | 랜드마크 ${this.allLMs.length}개 | 리뷰태그 ${this.reviewTags.length}개`);
  }

  _add(kw) {
    if (!kw) return;
    const k = kw.trim().replace(/\s+/g, ' ');
    if (k.length < 2 || k.length > 50 || this.tried.has(k) || this.buffer.includes(k)) return;
    // ★ 글로벌 블랙리스트: 키워드 토큰 중 잡동사니가 있으면 스킵
    const tokens = k.split(' ');
    if (tokens.some(t => GLOBAL_KW_STOPWORDS.has(t))) return;
    // ★ 업종 격리: catCode에 차단된 단어가 포함되면 스킵
    const blocked = CAT_BLOCKED[this.catCode];
    if (blocked && blocked.some(b => k.includes(b))) return;
    this.buffer.push(k);
  }

  next(n = 120) {
    // ★ 무한 루프: round 제한 없음 — 버퍼가 찰 때까지 영원히 생성
    let safety = 0;
    while (this.buffer.length < n && safety < 99999) {
      this._generateRound(this.round++);
      safety++;
    }
    const batch = this.buffer.splice(0, n);
    batch.forEach(k => this.tried.add(k));
    return batch;
  }

  // ★ 무한 — 절대 고갈되지 않음 (Phase 4가 영원히 생성)
  get exhausted() { return false; }

  _generateRound(round) {
    const {
      regionPrefixes, coreServices, extServices, reviewTags, compoundMenus,
      suffix, intents, sits, mods, alone, placeSuffixes,
      name, category, catCode, roadName, stations, sights, shopping, allLMs,
      cityBare, citySi, cityTokens, guTokens, dongTokens, lmTokens,
    } = this;

    const add = kw => this._add(kw);

    const R1 = regionPrefixes.filter(p => p.split(' ').length === 1);
    const R2 = regionPrefixes.filter(p => p.split(' ').length === 2);
    const R3 = regionPrefixes.filter(p => p.split(' ').length === 3);
    const R4 = regionPrefixes.filter(p => p.split(' ').length >= 4);
    const RA = regionPrefixes;

    const CS = (n=25) => coreServices.slice(0, n);
    const ES = (n=45) => extServices.slice(0, n);
    const CM = () => compoundMenus; // ★ v12.2: 복합메뉴 합성 재활성화 (프랑켄슈타인용)
    const SF = (n=15) => suffix.slice(0, n);
    const PS = (n=999) => placeSuffixes.slice(0, n);  // ★ 기본 전수
    const IN = (n=10) => intents.slice(0, n);
    const A  = ()     => alone;

    const addCombo = (prefixes, services, sfxList) => {
      prefixes.forEach(r => {
        services.forEach(s => {
          sfxList.forEach(sf => add(`${r} ${s} ${sf}`));
          add(`${r} ${s}`);
        });
      });
    };

    // ★ v12 확장된 고객 자연어 패턴
    const CUSTOMER_INTENTS = ['맛집','추천','맛있는곳','맛있는집','맛잇는집','유명한곳','잘하는곳','인기맛집','핫플','가성비','현지인맛집','후기좋은','인기','유명','잘하는','괜찮은곳','가볼만한곳','어디','좋은곳','맛집추천','추천맛집','인기맛집'];
    const NEARBY_WORDS = ['근처','주변','인근','가까운','앞','부근','주변맛집','근처맛집','인근맛집'];
    const TIME_CONTEXT = ['점심','저녁','아침','야식','주말','토요일','일요일','평일','오늘','당일','새벽','브런치'];
    const PURPOSE_WORDS = ['데이트','혼밥','혼술','가족','회식','모임','친구','단체','소개팅','생일','기념일','돌잔치','상견례','접대','가족외식','가족모임'];
    const FOOD_CONTEXT = ['한식','양식','중식','일식','분식']; // 음식 카테고리 문맥어
    const VIBE_WORDS = ['분위기좋은','뷰좋은','깔끔한','조용한','넓은','아늑한','예쁜','감성','인스타','모던한','전통','로컬'];

    console.log(`[R${round}] 생성 중... buffer: ${this.buffer.length}`);

    switch (round) {

      // ══ R0: ★★★ 2어 짧은 키워드 (최고 적중률) ★★★ ══
      // 가장 많이 검색되는 패턴: "지역 업종", "지역 메뉴"
      case 0:
        // 1순위: 지역+업종단독어 (부산 맛집, 수영 식당)
        R1.forEach(r => {
          A().forEach(a => { add(`${r} ${a}`); add(`${a} ${r}`); });
          if (category) { add(`${r} ${category}`); add(`${category} ${r}`); }
        });
        // 2순위: 지역+핵심메뉴 (부산 칼국수, 수영 비빔국수)
        R1.forEach(r => {
          CS(15).forEach(s => { add(`${r} ${s}`); add(`${s} ${r}`); });
        });
        break;

      // ══ R1: 3어 고적중 (지역+메뉴+맛집/추천) ══
      case 1:
        R1.forEach(r => {
          CS(15).forEach(s => {
            ['맛집','추천','맛있는곳','잘하는곳','유명'].forEach(sf => add(`${r} ${s} ${sf}`));
          });
          A().forEach(a => {
            ['추천','맛집','인기','유명','잘하는곳','맛있는곳','맛있는집'].forEach(sf => add(`${r} ${a} ${sf}`));
          });
          if (category) {
            ['맛집','추천','인기','유명','잘하는곳'].forEach(sf => add(`${r} ${category} ${sf}`));
          }
        });
        break;

      // ══ R2: 단일지역 × 핵심메뉴 × 전체 접미어 ══
      case 2:
        R1.forEach(r => {
          CS().forEach(s => {
            PS().forEach(sf => add(`${r} ${s} ${sf}`));
          });
        });
        break;

      // ══ R3: 단일지역 × 메뉴 × 고객의도어 ══
      case 3:
        R1.forEach(r => {
          CS().forEach(s => {
            CUSTOMER_INTENTS.forEach(ci => add(`${r} ${s} ${ci}`));
          });
        });
        break;

      // ══ R4: ★ 근처/주변/인근 패턴 — 전수조사 (v12 강화) ══
      case 4:
        [...R1, ...allLMs.slice(0,8), ...(roadName?[roadName]:[])].forEach(r => {
          NEARBY_WORDS.forEach(nw => {
            A().forEach(a => add(`${r} ${nw} ${a}`));
            if (category) add(`${r} ${nw} ${category}`);
            CS(12).forEach(s => add(`${r} ${nw} ${s}`));
            CM(10).forEach(cm => add(`${r} ${nw} ${cm}`));
            PS(6).forEach(sf => add(`${r} ${nw} ${sf}`));
            add(`${r} ${nw} 맛집`);
            add(`${r} ${nw} 추천`);
          });
        });
        break;

      // ══ R5: 단순 2어 조합 + 역순 (구지도 최적화) ══
      case 5:
        R1.forEach(r => {
          CS(25).forEach(s => { add(`${s} ${r}`); add(`${r} ${s}`); add(`${r}${s}`); add(`${s}${r}`); });
          CM(15).forEach(cm => { add(`${cm} ${r}`); add(`${r} ${cm}`); });
          if (category) { add(`${category} ${r}`); add(`${r} ${category}`); add(`${r}${category}`); }
          A().forEach(a => { add(`${a} ${r}`); add(`${r} ${a}`); add(`${r}${a}`); });
        });
        break;

      // ══ R6: 이중지역 × 핵심메뉴 × 접미어 ══
      case 6:
        addCombo(R2, CS(), PS(10));
        R2.forEach(r => {
          if (category) PS(8).forEach(sf => add(`${r} ${category} ${sf}`));
          A().forEach(a => PS(8).forEach(sf => add(`${r} ${a} ${sf}`)));
        });
        break;

      // ══ R7: 이중지역 × 핵심메뉴 × 고객 의도어 ══
      case 7:
        R2.forEach(r => {
          CS().forEach(s => {
            CUSTOMER_INTENTS.slice(0,10).forEach(ci => add(`${r} ${s} ${ci}`));
          });
          if (category) CUSTOMER_INTENTS.slice(0,8).forEach(ci => add(`${r} ${category} ${ci}`));
        });
        break;

      // ══ R8: ★ 복합메뉴 × 이중지역 × 접미어 (v12 신규) ══
      case 8:
        R2.forEach(r => {
          CM().forEach(cm => {
            PS(8).forEach(sf => add(`${r} ${cm} ${sf}`));
            add(`${r} ${cm}`);
          });
        });
        break;

      // ══ R9: 시간/목적 패턴 ══
      case 9:
        R1.forEach(r => {
          TIME_CONTEXT.forEach(tc => {
            A().forEach(a => add(`${r} ${tc} ${a}`));
            if (category) add(`${r} ${tc} ${category}`);
            CS(8).forEach(s => add(`${r} ${tc} ${s}`));
            CM(6).forEach(cm => add(`${r} ${tc} ${cm}`));
          });
          PURPOSE_WORDS.forEach(pw => {
            A().forEach(a => add(`${r} ${pw} ${a}`));
            if (category) add(`${r} ${pw} ${category}`);
            CS(6).forEach(s => add(`${r} ${pw} ${s}`));
          });
        });
        break;

      // ══ R10: 삼중지역 × 메뉴/복합메뉴 × 접미어 ══
      case 10:
        R3.forEach(r => {
          CS(15).forEach(s => {
            PS(6).forEach(sf => add(`${r} ${s} ${sf}`));
            add(`${r} ${s}`);
          });
          CM(10).forEach(cm => {
            PS(4).forEach(sf => add(`${r} ${cm} ${sf}`));
            add(`${r} ${cm}`);
          });
          if (category) { add(`${r} ${category} 추천`); add(`${r} ${category} 맛집`); }
          A().forEach(a => add(`${r} ${a} 추천`));
        });
        break;

      // ══ R11: 업장명 × 전체 지역 ══
      case 11: {
        const clean = name.replace(/\s*(본점|[가-힣]{1,4}\d*호?점)$/, '').trim();
        add(clean); add(name);
        ['추천','후기','맛집','메뉴','가격','위치','예약','주차','영업시간','전화번호'].forEach(w => {
          add(`${clean} ${w}`);
        });
        RA.slice(0, 20).forEach(r => {
          add(`${r} ${clean}`); add(`${r} ${clean} 추천`);
          add(`${clean} ${r}`); add(`${r} ${clean} 맛집`);
        });
        CUSTOMER_INTENTS.slice(0,8).forEach(ci => { add(`${clean} ${ci}`); add(`${name} ${ci}`); });
        break;
      }

      // ══ R12: ★ 근접어 × 랜드마크/역 전수 (v12 강화) ══
      case 12:
        allLMs.slice(0, 15).forEach(lm => {
          NEARBY_WORDS.forEach(nw => {
            CS(15).forEach(s => add(`${lm} ${nw} ${s}`));
            CM(10).forEach(cm => add(`${lm} ${nw} ${cm}`));
            A().forEach(a => add(`${lm} ${nw} ${a}`));
            if (category) add(`${lm} ${nw} ${category}`);
            PS(6).forEach(sf => add(`${lm} ${nw} ${sf}`));
          });
        });
        break;

      // ══ R13: 수식어(감성/분위기) × 지역 × 업종 ══
      case 13:
        R1.forEach(r => {
          [...mods.slice(0,10), ...VIBE_WORDS].forEach(mod => {
            A().forEach(a => add(`${r} ${mod} ${a}`));
            if (category) add(`${r} ${mod} ${category}`);
            CS(6).forEach(s => add(`${r} ${mod} ${s}`));
            add(`${r} ${mod}`);
          });
        });
        break;

      // ══ R14: 리뷰태그 × 전체 지역 × 접미어 ══
      case 14:
        reviewTags.slice(0, 20).forEach(tag => {
          [...R1, ...R2.slice(0, 8)].forEach(r => {
            PS(6).forEach(sf => add(`${r} ${tag} ${sf}`));
            add(`${r} ${tag}`);
            add(`${tag} ${r}`);
          });
          add(`${tag} 추천`); add(`${tag} 맛집`); add(`${tag} 잘하는곳`);
        });
        break;

      // ══ R15: ★ 음식 카테고리 문맥어 × 지역 × 메뉴 (v12 신규) ══
      case 15:
        if (catCode === 'food') {
          R1.forEach(r => {
            FOOD_CONTEXT.forEach(fc => {
              CS(12).forEach(s => add(`${r} ${fc} ${s}`));
              CM(8).forEach(cm => add(`${r} ${fc} ${cm}`));
              PS(6).forEach(sf => add(`${r} ${fc} ${sf}`));
              add(`${r} ${fc}`);
              add(`${r} ${fc} 맛집`);
              add(`${r} ${fc} 추천`);
            });
          });
          // 랜드마크 + 한식 등
          allLMs.slice(0, 8).forEach(lm => {
            FOOD_CONTEXT.forEach(fc => {
              CS(8).forEach(s => add(`${lm} ${fc} ${s}`));
              add(`${lm} ${fc} 맛집`);
            });
          });
        }
        break;

      // ══ R16: ★ 긴 체인 패턴 (5-6어) (v12 신규) ══
      case 16:
        // "벡스코 마린시티 요트 주변 한식 칼국수 맛집" 스타일
        [...R2.slice(0,6), ...R3.slice(0,4)].forEach(r => {
          NEARBY_WORDS.slice(0,4).forEach(nw => {
            CS(8).forEach(s => {
              PS(4).forEach(sf => {
                const kw = `${r} ${nw} ${s} ${sf}`;
                if (kw.length <= 35) add(kw);
              });
            });
            CM(6).forEach(cm => {
              PS(3).forEach(sf => {
                const kw = `${r} ${nw} ${cm} ${sf}`;
                if (kw.length <= 35) add(kw);
              });
            });
          });
        });
        // 음식 문맥어 포함 체인
        if (catCode === 'food') {
          [...R2.slice(0,4)].forEach(r => {
            NEARBY_WORDS.slice(0,3).forEach(nw => {
              FOOD_CONTEXT.slice(0,2).forEach(fc => {
                CS(6).forEach(s => {
                  const kw = `${r} ${nw} ${fc} ${s} 맛집`;
                  if (kw.length <= 35) add(kw);
                });
              });
            });
          });
        }
        break;

      // ══ R17: ★ 시간+목적 × 이중지역 (v12 확장) ══
      case 17:
        R2.slice(0,8).forEach(r => {
          TIME_CONTEXT.slice(0,6).forEach(tc => {
            A().forEach(a => add(`${r} ${tc} ${a}`));
            CS(6).forEach(s => add(`${r} ${tc} ${s}`));
          });
          PURPOSE_WORDS.slice(0,6).forEach(pw => {
            A().forEach(a => add(`${r} ${pw} ${a}`));
            CS(4).forEach(s => add(`${r} ${pw} ${s}`));
          });
        });
        break;

      // ══ R18: 도로명 × 메뉴/복합메뉴 ══
      case 18:
        if (roadName) {
          CS(15).forEach(s => {
            PS(6).forEach(sf => add(`${roadName} ${s} ${sf}`));
            add(`${roadName} ${s}`);
          });
          CM(10).forEach(cm => {
            PS(4).forEach(sf => add(`${roadName} ${cm} ${sf}`));
          });
          NEARBY_WORDS.slice(0,4).forEach(nw => {
            A().forEach(a => add(`${roadName} ${nw} ${a}`));
            CS(8).forEach(s => add(`${roadName} ${nw} ${s}`));
          });
          if (category) add(`${roadName} 근처 ${category} 추천`);
        }
        break;

      // ══ R19: 역/명소 × 메뉴 × 접미어 전수 ══
      case 19:
        allLMs.slice(0, 15).forEach(lm => {
          CS(15).forEach(s => {
            PS(8).forEach(sf => add(`${lm} ${s} ${sf}`));
            add(`${lm} ${s}`); add(`${s} ${lm}`);
          });
          CM(10).forEach(cm => {
            PS(4).forEach(sf => add(`${lm} ${cm} ${sf}`));
            add(`${lm} ${cm}`);
          });
          if (category) { add(`${lm} ${category} 추천`); add(`${lm} 근처 ${category}`); }
          A().forEach(a => { add(`${lm} ${a} 추천`); add(`${lm} ${a}`); });
        });
        break;

      // ══ R20: ★ 자연어 질문형 검색 ══
      case 20: {
        const QP = ['어디가좋을까','어디','가볼만한','괜찮은','좋은','가볼만한곳',
          '먹을만한곳','갈만한곳','가기좋은','모임하기좋은','먹을곳','갈곳'];
        R1.forEach(r => {
          QP.forEach(qp => {
            A().forEach(a => add(`${r} ${qp} ${a}`));
            if (category) add(`${r} ${qp} ${category}`);
            add(`${r} ${qp}`);
          });
        });
        break;
      }

      // ══ R21: 계절/날씨 패턴 ══
      case 21: {
        const SEASON = ['봄','여름','가을','겨울','비오는날','추운날','더운날','날씨좋은날','주말'];
        R1.forEach(r => {
          SEASON.forEach(sw => {
            A().forEach(a => add(`${r} ${sw} ${a}`));
            if (category) add(`${r} ${sw} ${category}`);
            CS(6).forEach(s => add(`${r} ${sw} ${s}`));
          });
        });
        break;
      }

      // ══ R22: 가격대/인원수/연령대 ══
      case 22: {
        const PRICE = ['가성비','저렴한','싼','합리적인','고급','프리미엄','특별한'];
        const GROUP = ['2인','4인','혼자','단체','소규모','대규모'];
        const AGE = ['어린이','아이','아기','노인','학생','대학생','직장인','커플','신혼','외국인'];
        R1.forEach(r => {
          [...PRICE, ...GROUP, ...AGE].forEach(w => {
            A().forEach(a => add(`${r} ${w} ${a}`));
            if (category) add(`${r} ${w} ${category}`);
            CS(4).forEach(s => add(`${r} ${w} ${s}`));
          });
        });
        break;
      }

      // ══ R23: ★ 역세권 전수 (매우 높은 실제 검색량) ══
      case 23:
        stations.slice(0, 12).forEach(st => {
          A().forEach(a => {
            add(`${st} ${a}`);
            CUSTOMER_INTENTS.slice(0,8).forEach(ci => add(`${st} ${a} ${ci}`));
          });
          if (category) {
            add(`${st} ${category}`);
            CUSTOMER_INTENTS.slice(0,6).forEach(ci => add(`${st} ${category} ${ci}`));
          }
          CS(12).forEach(s => {
            add(`${st} ${s}`); add(`${st} ${s} 추천`); add(`${st} ${s} 맛집`);
          });
          CM(8).forEach(cm => {
            add(`${st} ${cm}`); add(`${st} ${cm} 맛집`);
          });
          PURPOSE_WORDS.slice(0,6).forEach(pw => add(`${st} ${pw} ${A()[0]||'맛집'}`));
          TIME_CONTEXT.slice(0,6).forEach(tc => add(`${st} ${tc} ${A()[0]||'맛집'}`));
        });
        break;

      // ══ R24: 관광지/쇼핑몰 전수 ══
      case 24:
        sights.slice(0, 10).forEach(si => {
          A().forEach(a => {
            add(`${si} ${a}`); add(`${si} 근처 ${a}`); add(`${si} 주변 ${a}`); add(`${si} 인근 ${a}`);
          });
          if (category) { add(`${si} ${category}`); add(`${si} 근처 ${category}`); add(`${si} 주변 ${category}`); }
          CS(10).forEach(s => { add(`${si} ${s}`); add(`${si} ${s} 맛집`); add(`${si} ${s} 추천`); });
          CM(6).forEach(cm => add(`${si} ${cm} 맛집`));
        });
        shopping.slice(0, 6).forEach(sh => {
          A().forEach(a => {
            add(`${sh} 근처 ${a}`); add(`${sh} 주변 ${a}`); add(`${sh} ${a}`);
          });
          if (category) add(`${sh} 근처 ${category}`);
          CS(6).forEach(s => add(`${sh} ${s}`));
        });
        break;

      // ══ R25: ★ "OO 맛집 추천" 3어 고적중 패턴 ══
      case 25:
        R1.forEach(r => {
          const CI = ['맛집 추천','추천 맛집','맛집 순위','인기 맛집','핫플 추천','가볼만한 맛집','숨은 맛집','현지인 맛집','현지인 추천','로컬 맛집','숨겨진 맛집'];
          CI.forEach(ci => {
            add(`${r} ${ci}`);
            if (category) add(`${r} ${category} ${ci.split(' ')[0]}`);
          });
          VIBE_WORDS.forEach(mod => {
            A().forEach(a => add(`${r} ${mod} ${a}`));
            if (category) add(`${r} ${mod} ${category}`);
          });
        });
        break;

      // ══ R26: ★ 근접어 × 랜드마크 × 시간/목적 × 메뉴 (v12 긴체인) ══
      case 26:
        allLMs.slice(0, 8).forEach(lm => {
          NEARBY_WORDS.slice(0,4).forEach(nw => {
            TIME_CONTEXT.slice(0,4).forEach(tc => {
              CS(6).forEach(s => {
                const kw = `${lm} ${nw} ${tc} ${s} 맛집`;
                if (kw.length <= 35) add(kw);
              });
            });
            if (catCode === 'food') {
              FOOD_CONTEXT.slice(0,3).forEach(fc => {
                CS(6).forEach(s => {
                  const kw = `${lm} ${nw} ${fc} ${s} 맛집`;
                  if (kw.length <= 35) add(kw);
                });
              });
            }
          });
        });
        break;

      // ══ R27: 상황어 × 지역 × 메뉴 ══
      case 27:
        [...R1, ...R2.slice(0, 6)].forEach(r => {
          sits.slice(0, 8).forEach(sit => {
            CS(10).forEach(s => add(`${r} ${sit} ${s}`));
            CM(6).forEach(cm => add(`${r} ${sit} ${cm}`));
            if (category) add(`${r} ${sit} ${category}`);
            A().forEach(a => add(`${r} ${sit} ${a}`));
          });
        });
        break;

      // ══ R28: ★ 이중지역 + 근처/주변/인근 전수 (v12 강화) ══
      case 28:
        R2.slice(0, 10).forEach(r => {
          NEARBY_WORDS.forEach(nw => {
            A().forEach(a => add(`${r} ${nw} ${a}`));
            if (category) add(`${r} ${nw} ${category}`);
            CS(10).forEach(s => add(`${r} ${nw} ${s}`));
            CM(6).forEach(cm => add(`${r} ${nw} ${cm}`));
          });
          PURPOSE_WORDS.slice(0,6).forEach(pw => {
            A().forEach(a => add(`${r} ${pw} ${a}`));
            CS(4).forEach(s => add(`${r} ${pw} ${s}`));
          });
          TIME_CONTEXT.slice(0,6).forEach(tc => {
            A().forEach(a => add(`${r} ${tc} ${a}`));
            CS(4).forEach(s => add(`${r} ${tc} ${s}`));
          });
        });
        break;

      // ══ R29: 전체 접미어 × 단일지역 소진 ══
      case 29:
        R1.forEach(r => {
          CS(25).forEach(s => {
            placeSuffixes.forEach(sf => add(`${r} ${s} ${sf}`));
          });
        });
        break;

      // ══ R30: 전체 접미어 × 이중지역 소진 ══
      case 30:
        R2.forEach(r => {
          CS(20).forEach(s => {
            placeSuffixes.forEach(sf => add(`${r} ${s} ${sf}`));
          });
        });
        break;

      // ══ R31: 복합메뉴 × 이중지역 × 근접어 전수 ══
      case 31:
        R2.slice(0, 8).forEach(r => {
          CM().forEach(cm => {
            NEARBY_WORDS.slice(0,4).forEach(nw => add(`${r} ${nw} ${cm}`));
            PS(8).forEach(sf => add(`${r} ${cm} ${sf}`));
          });
        });
        break;

      // ══ R32: 리뷰태그+고객의도어 교차 ══
      case 32:
        reviewTags.slice(0, 20).forEach(tag => {
          CUSTOMER_INTENTS.slice(0,8).forEach(ci => {
            R1.forEach(r => add(`${r} ${tag} ${ci}`));
          });
          NEARBY_WORDS.slice(0,3).forEach(nw => {
            R1.forEach(r => add(`${r} ${nw} ${tag}`));
          });
        });
        break;

      // ══ R33: 확장서비스 × 전체 지역 전수 ══
      case 33:
        [...R1, ...R2.slice(0, 6)].forEach(r => {
          ES(40).forEach(s => {
            if (coreServices.includes(s)) return;
            PS(8).forEach(sf => add(`${r} ${s} ${sf}`));
            add(`${r} ${s}`); add(`${s} ${r}`);
          });
        });
        break;

      // ══ R34: ★ 삼중지역 + 근접어 전수 (v12 신규) ══
      case 34:
        R3.slice(0, 8).forEach(r => {
          NEARBY_WORDS.slice(0,4).forEach(nw => {
            CS(10).forEach(s => add(`${r} ${nw} ${s}`));
            CM(6).forEach(cm => add(`${r} ${nw} ${cm}`));
            A().forEach(a => add(`${r} ${nw} ${a}`));
          });
        });
        break;

      // ══ R35: ★ 사중지역 + 메뉴 (v12 신규) ══
      case 35:
        R4.slice(0, 6).forEach(r => {
          CS(10).forEach(s => {
            PS(4).forEach(sf => add(`${r} ${s} ${sf}`));
            add(`${r} ${s}`);
          });
          CM(6).forEach(cm => add(`${r} ${cm} 맛집`));
        });
        break;

      // ══ R36: ★ 랜드마크 체인 × 근접어 × 문맥어 × 메뉴 (v12 최장체인) ══
      case 36: {
        // 예: "벡스코 마린시티 요트 주변 한식 칼국수 맛집"
        if (lmTokens.length >= 2 && catCode === 'food') {
          for (let i = 0; i < lmTokens.length; i++) {
            for (let j = i+1; j < lmTokens.length; j++) {
              const chain = `${lmTokens[i]} ${lmTokens[j]}`;
              NEARBY_WORDS.slice(0,4).forEach(nw => {
                FOOD_CONTEXT.slice(0,3).forEach(fc => {
                  CS(8).forEach(s => {
                    const kw = `${chain} ${nw} ${fc} ${s} 맛집`;
                    if (kw.length <= 35) add(kw);
                  });
                });
                CS(8).forEach(s => {
                  const kw = `${chain} ${nw} ${s} 맛집`;
                  if (kw.length <= 35) add(kw);
                });
              });
            }
          }
        }
        break;
      }

      // ══ R37: 역/명소 × 시간/목적 × 메뉴 ══
      case 37:
        stations.slice(0, 10).forEach(st => {
          TIME_CONTEXT.slice(0,6).forEach(tc => {
            CS(8).forEach(s => add(`${st} ${tc} ${s}`));
            A().forEach(a => add(`${st} ${tc} ${a}`));
          });
          PURPOSE_WORDS.slice(0,6).forEach(pw => {
            CS(6).forEach(s => add(`${st} ${pw} ${s}`));
            A().forEach(a => add(`${st} ${pw} ${a}`));
          });
        });
        break;

      // ══ R38: 복합메뉴 × 근접어 × 단일지역 전수 ══
      case 38:
        R1.forEach(r => {
          CM().forEach(cm => {
            NEARBY_WORDS.forEach(nw => add(`${r} ${nw} ${cm}`));
            CUSTOMER_INTENTS.slice(0,8).forEach(ci => add(`${r} ${cm} ${ci}`));
          });
        });
        break;

      // ══ R39: 리뷰태그 × 상황어 × 지역 (대체) ══
      case 39:
        reviewTags.slice(0, 15).forEach(tag => {
          sits.slice(0, 6).forEach(sit => {
            R1.forEach(r => add(`${r} ${sit} ${tag}`));
          });
        });
        break;

      // ══════════════════════════════════════════════════════
      // Phase 3 (R40~500): 무자비한 프랑켄슈타인 카테시안 곱
      // 모든 경우의 수를 기계적으로 곱함
      // ══════════════════════════════════════════════════════
      default: {
        // ── Phase 3 영역 (R40~500) ──
        if (round <= 500) {
          const idx = round - 40;
          const totalPhases = 12;
          const phase = idx % totalPhases;
          const cycle = Math.floor(idx / totalPhases);

          switch (phase) {
            // 위상 0: regionPrefix[i] × ALL services × ALL suffixes (전수 카테시안)
            case 0: {
              const rIdx = cycle % RA.length;
              const r = RA[rIdx]; if (!r) break;
              CS(25).forEach(s => {
                PS().forEach(sf => add(`${r} ${s} ${sf}`));
                add(`${r} ${s}`); add(`${s} ${r}`);
              });
              break;
            }
            // 위상 1: regionPrefix[i] × compoundMenus × suffixes
            case 1: {
              const rIdx = cycle % RA.length;
              const r = RA[rIdx]; if (!r) break;
              CM(30).forEach(cm => {
                PS().forEach(sf => add(`${r} ${cm} ${sf}`));
                add(`${r} ${cm}`);
              });
              break;
            }
            // 위상 2: region × NEARBY × ALL services
            case 2: {
              const rIdx = cycle % RA.length;
              const r = RA[rIdx]; if (!r) break;
              NEARBY_WORDS.forEach(nw => {
                ES(45).forEach(s => add(`${r} ${nw} ${s}`));
                A().forEach(a => add(`${r} ${nw} ${a}`));
              });
              break;
            }
            // 위상 3: region × TIME × PURPOSE × services (4어절)
            case 3: {
              const rIdx = cycle % RA.length;
              const r = RA[rIdx]; if (!r) break;
              TIME_CONTEXT.forEach(tc => {
                CS(12).forEach(s => add(`${r} ${tc} ${s}`));
                A().forEach(a => add(`${r} ${tc} ${a}`));
                PS(8).forEach(sf => add(`${r} ${tc} ${sf}`));
              });
              PURPOSE_WORDS.forEach(pw => {
                CS(8).forEach(s => add(`${r} ${pw} ${s}`));
                A().forEach(a => add(`${r} ${pw} ${a}`));
              });
              break;
            }
            // 위상 4: region × extServices × ALL suffixes (확장서비스 전수)
            case 4: {
              const rIdx = cycle % RA.length;
              const r = RA[rIdx]; if (!r) break;
              ES(45).forEach(s => {
                PS().forEach(sf => add(`${r} ${s} ${sf}`));
                add(`${r} ${s}`);
              });
              break;
            }
            // 위상 5: region × reviewTags × suffixes
            case 5: {
              const rIdx = cycle % RA.length;
              const r = RA[rIdx]; if (!r) break;
              reviewTags.forEach(tag => {
                PS(10).forEach(sf => add(`${r} ${tag} ${sf}`));
                add(`${r} ${tag}`);
                CUSTOMER_INTENTS.slice(0,8).forEach(ci => add(`${r} ${tag} ${ci}`));
              });
              break;
            }
            // 위상 6: modifier × region × service (수식어 전수)
            case 6: {
              const rIdx = cycle % R1.length;
              const r = R1[rIdx]; if (!r) break;
              [...mods, ...VIBE_WORDS].forEach(mod => {
                CS(15).forEach(s => add(`${r} ${mod} ${s}`));
                A().forEach(a => add(`${r} ${mod} ${a}`));
                add(`${mod} ${r}`);
              });
              break;
            }
            // 위상 7: 역순 조합 (서비스+지역, 접미어+서비스+지역)
            case 7: {
              const rIdx = cycle % RA.length;
              const r = RA[rIdx]; if (!r) break;
              CS(20).forEach(s => {
                add(`${s} ${r}`);
                PS(8).forEach(sf => add(`${s} ${sf} ${r}`));
                add(`${s} ${r} 추천`);
              });
              break;
            }
            // 위상 8: 랜드마크 × TIME/PURPOSE × service × suffix (5어절)
            case 8: {
              allLMs.slice(0, 10).forEach(lm => {
                TIME_CONTEXT.slice(0,6).forEach(tc => {
                  CS(8).forEach(s => {
                    PS(4).forEach(sf => {
                      const kw = `${lm} ${tc} ${s} ${sf}`;
                      if (kw.length <= 45) add(kw);
                    });
                    add(`${lm} ${tc} ${s}`);
                  });
                });
              });
              break;
            }
            // 위상 9: 이중지역 + modifier + service + suffix (5어절)
            case 9: {
              const rIdx = cycle % R2.length;
              const r = R2[rIdx]; if (!r) break;
              [...mods.slice(0,6), ...VIBE_WORDS.slice(0,4)].forEach(mod => {
                CS(10).forEach(s => {
                  PS(6).forEach(sf => {
                    const kw = `${r} ${mod} ${s} ${sf}`;
                    if (kw.length <= 45) add(kw);
                  });
                });
              });
              break;
            }
            // 위상 10: 삼중/사중지역 × service (무식한 긴 prefix)
            case 10: {
              [...R3, ...R4].forEach(r => {
                CS(15).forEach(s => {
                  PS(6).forEach(sf => add(`${r} ${s} ${sf}`));
                  add(`${r} ${s}`);
                });
                A().forEach(a => {
                  PS(4).forEach(sf => add(`${r} ${a} ${sf}`));
                });
              });
              break;
            }
            // 위상 11: 랜드마크 체인 × NEARBY × 서비스 (멀티 랜드마크)
            case 11: {
              if (lmTokens.length >= 2) {
                for (let i = 0; i < lmTokens.length; i++) {
                  for (let j = 0; j < lmTokens.length; j++) {
                    if (i === j) continue;
                    const chain = `${lmTokens[i]} ${lmTokens[j]}`;
                    NEARBY_WORDS.slice(0,4).forEach(nw => {
                      CS(8).forEach(s => add(`${chain} ${nw} ${s}`));
                      A().forEach(a => add(`${chain} ${nw} ${a}`));
                    });
                    CS(6).forEach(s => add(`${chain} ${s}`));
                  }
                }
              }
              break;
            }
          }
        }
        // ══════════════════════════════════════════════════════
        // ★★★ Phase 4 (R501~): 무한 동력 엔진 ★★★
        // 수식어 다중 스태킹, 역순 조합, 접두/접미 뒤섞기
        // → 새로운 키워드가 나올 때까지 영원히 회전
        // ══════════════════════════════════════════════════════
        else {
          const idx4 = round - 501;
          const engine = idx4 % 10;
          const cycle4 = Math.floor(idx4 / 10);

          // 모든 풀을 하나로 합침
          const ALL_MODS = [...new Set([...mods, ...VIBE_WORDS,
            '진짜','레알','찐','완전','극강','최고의','대박','미친',
            '소문난','알려진','검증된','믿을만한','확실한','인정받은'])];
          const ALL_SFX = [...new Set([...placeSuffixes, ...suffix, ...intents,
            'ㄱㄱ','가자','갈까','어때','추천좀','알려줘','있을까','찾는중'])];
          const ALL_SVC = [...new Set([...coreServices, ...extServices])];
          const ALL_RGN = RA;

          switch (engine) {
            // 엔진 0: 수식어 2개 스태킹 + 지역 + 서비스
            //  ex) "진짜 가성비 좋은 부산 칼국수"
            case 0: {
              const mIdx = cycle4 % ALL_MODS.length;
              const m2Idx = (cycle4 + 7) % ALL_MODS.length; // 소수 오프셋으로 다른 수식어
              const mod1 = ALL_MODS[mIdx];
              const mod2 = ALL_MODS[m2Idx];
              if (mod1 === mod2) break;
              R1.forEach(r => {
                ALL_SVC.slice(0, 15).forEach(s => {
                  add(`${mod1} ${mod2} ${r} ${s}`);
                  add(`${r} ${mod1} ${mod2} ${s}`);
                });
              });
              break;
            }
            // 엔진 1: 접미어 2개 스태킹 + 지역 + 서비스
            //  ex) "부산 칼국수 맛집 추천"
            case 1: {
              const sIdx = cycle4 % ALL_SFX.length;
              const s2Idx = (cycle4 + 5) % ALL_SFX.length;
              const sf1 = ALL_SFX[sIdx];
              const sf2 = ALL_SFX[s2Idx];
              if (sf1 === sf2) break;
              R1.forEach(r => {
                ALL_SVC.slice(0, 12).forEach(s => {
                  add(`${r} ${s} ${sf1} ${sf2}`);
                });
                A().forEach(a => add(`${r} ${a} ${sf1} ${sf2}`));
              });
              break;
            }
            // 엔진 2: 수식어 앞 + 지역 + 서비스 + 접미어 뒤 (5어절)
            case 2: {
              const mIdx = cycle4 % ALL_MODS.length;
              const sfIdx = cycle4 % ALL_SFX.length;
              const mod = ALL_MODS[mIdx];
              const sf = ALL_SFX[sfIdx];
              R1.forEach(r => {
                ALL_SVC.slice(0, 10).forEach(s => {
                  const kw = `${mod} ${r} ${s} ${sf}`;
                  if (kw.length <= 50) add(kw);
                });
              });
              break;
            }
            // 엔진 3: 전체 역순 (서비스+지역+접미어 → 접미어+서비스+지역)
            case 3: {
              const rIdx = cycle4 % ALL_RGN.length;
              const r = ALL_RGN[rIdx]; if (!r) break;
              ALL_SVC.slice(0, 15).forEach(s => {
                ALL_SFX.slice(0, 10).forEach(sf => {
                  add(`${sf} ${s} ${r}`);
                  add(`${sf} ${r} ${s}`);
                  add(`${s} ${sf} ${r}`);
                });
              });
              break;
            }
            // 엔진 4: 수식어 3개 스태킹 (극한 프랑켄슈타인)
            //  ex) "추천 맛집 진짜 가성비 좋은 부산 칼국수"
            case 4: {
              const m1 = ALL_MODS[cycle4 % ALL_MODS.length];
              const m2 = ALL_MODS[(cycle4 + 3) % ALL_MODS.length];
              const m3 = ALL_MODS[(cycle4 + 7) % ALL_MODS.length];
              if (m1 === m2 || m2 === m3 || m1 === m3) break;
              R1.slice(0, 4).forEach(r => {
                ALL_SVC.slice(0, 6).forEach(s => {
                  add(`${m1} ${m2} ${m3} ${r} ${s}`);
                  add(`${r} ${m1} ${m2} ${s} ${m3}`);
                });
              });
              break;
            }
            // 엔진 5: 이중지역 + 수식어 + 서비스 + 접미어 (5어절)
            case 5: {
              const rIdx = cycle4 % R2.length;
              const r = R2[rIdx]; if (!r) break;
              const mIdx = cycle4 % ALL_MODS.length;
              ALL_SVC.slice(0, 10).forEach(s => {
                add(`${r} ${ALL_MODS[mIdx]} ${s}`);
                ALL_SFX.slice(0, 6).forEach(sf => {
                  const kw = `${r} ${ALL_MODS[mIdx]} ${s} ${sf}`;
                  if (kw.length <= 50) add(kw);
                });
              });
              break;
            }
            // 엔진 6: 랜드마크 × 수식어 × 서비스 × 접미어 × 접미어2
            case 6: {
              const lmIdx = cycle4 % Math.max(allLMs.length, 1);
              const lm = allLMs[lmIdx]; if (!lm) break;
              const mIdx = cycle4 % ALL_MODS.length;
              ALL_SVC.slice(0, 8).forEach(s => {
                ALL_SFX.slice(0, 6).forEach(sf => {
                  add(`${lm} ${ALL_MODS[mIdx]} ${s} ${sf}`);
                  add(`${ALL_MODS[mIdx]} ${lm} ${s} ${sf}`);
                });
              });
              break;
            }
            // 엔진 7: NEARBY + TIME + 지역 + 서비스 (4-5어절 역순)
            case 7: {
              const nwIdx = cycle4 % NEARBY_WORDS.length;
              const tcIdx = cycle4 % TIME_CONTEXT.length;
              R1.forEach(r => {
                ALL_SVC.slice(0, 8).forEach(s => {
                  add(`${NEARBY_WORDS[nwIdx]} ${r} ${TIME_CONTEXT[tcIdx]} ${s}`);
                  add(`${r} ${TIME_CONTEXT[tcIdx]} ${NEARBY_WORDS[nwIdx]} ${s}`);
                });
              });
              break;
            }
            // 엔진 8: PURPOSE + 수식어 + 지역 + 업종단독어
            case 8: {
              const pwIdx = cycle4 % PURPOSE_WORDS.length;
              const mIdx = cycle4 % ALL_MODS.length;
              R1.forEach(r => {
                A().forEach(a => {
                  add(`${PURPOSE_WORDS[pwIdx]} ${ALL_MODS[mIdx]} ${r} ${a}`);
                  add(`${r} ${PURPOSE_WORDS[pwIdx]} ${a} ${ALL_MODS[mIdx]}`);
                });
              });
              break;
            }
            // 엔진 9: 리뷰태그 × 수식어 × 지역 × 접미어
            case 9: {
              const tagIdx = cycle4 % Math.max(reviewTags.length, 1);
              const tag = reviewTags[tagIdx]; if (!tag) break;
              const mIdx = cycle4 % ALL_MODS.length;
              R1.forEach(r => {
                add(`${r} ${ALL_MODS[mIdx]} ${tag}`);
                ALL_SFX.slice(0, 6).forEach(sf => {
                  add(`${r} ${tag} ${ALL_MODS[mIdx]} ${sf}`);
                });
              });
              break;
            }
          }
        }
        break;
      }
    }
    if (round % 50 === 0) console.log(`[R${round}] 버퍼 ${this.buffer.length}개 | 시도 ${this.tried.size}개`);
  }
}


// buildKeywordGroups는 호환성 유지용으로 유지
function buildKeywordGroups(info) {
  const stream = new InfiniteKeywordStream(info);
  // 초기 3라운드만 생성해서 반환 (analyze 엔드포인트는 스트림 방식으로 처리)
  stream.next(9999);
  return { stream, newGroups:[], oldGroups:[] };
}

// ══════════════════════════════════════════════════════════
// ██  관공서/랜드마크/학교 키워드 생성 헬퍼  ██
// ══════════════════════════════════════════════════════════
// 구/동 이름으로 주변 관공서·시설 키워드 자동 생성
function buildGovLandmarkKeywords(regions, guM, dongM, cityM) {
  const kws = new Set();

  // ① 구청 / 시청 / 동 주민센터
  if (guM) {
    const gu = guM[1];
    kws.add(gu+'청');          // 수영구청
    kws.add(gu+' 구청');
    kws.add(gu+'청 근처');
    kws.add(gu+' 경찰서');
    kws.add(gu+' 소방서');
  }
  if (dongM) {
    const dong = dongM[1];
    kws.add(dong+' 주민센터');
    kws.add(dong+' 주민센터 근처');
    kws.add(dong+' 동사무소 근처');
  }
  if (cityM) {
    const city = cityM[1].replace(/시$/,'');
    if (city.length >= 2) {
      kws.add(city+'시청');
      kws.add(city+' 시청 근처');
      kws.add(city+' 터미널 근처');
    }
  }

  // ② 주요 학교 (지역명+학교 조합)
  const schoolTypes = ['초등학교','중학교','고등학교','대학교','대학'];
  regions.slice(0,4).forEach(r => {
    schoolTypes.forEach(st => kws.add(r+' '+st+' 근처'));
    kws.add(r+' 학교 근처');
  });

  // ③ 주요 시설
  const facilities = ['도서관','병원','마트','백화점','쇼핑몰','공원','체육관','수영장','우체국','은행'];
  regions.slice(0,3).forEach(r => {
    facilities.forEach(f => kws.add(r+' '+f+' 근처'));
  });

  // ④ LANDMARK_DB에 등록된 역/명소
  regions.forEach(r => {
    const db = LANDMARK_DB[r]; if (!db) return;
    (db.station||[]).slice(0,3).forEach(st => {
      kws.add(st+' 근처');
      kws.add(st+' 앞');
    });
    (db.sights||[]).slice(0,3).forEach(s => {
      kws.add(s+' 근처');
      kws.add(s+' 주변');
    });
    (db.shopping||[]).slice(0,2).forEach(s => {
      kws.add(s+' 근처');
    });
  });

  return [...kws].filter(k => k.length >= 4 && k.length <= 22);
}

// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// STEP 3: 순위 확인 — XHR 인터셉트 + API + DOM 3중 체계
// ──────────────────────────────────────────────────────────
// 신지도/구지도 판별 기준 (사진 수):
//   신지도 = 검색 결과 카드에 사진 2장 이상 (썸네일 슬라이더)
//   구지도 = 사진 1장 (단순 카드)
//   → 이미지가 차단돼도 img[data-src], [style*="background"], li개수로 판별
// ══════════════════════════════════════════════════════════
const pagePool = [];
// ══════════════════════════════════════════════════════════
// ★ 모바일 Page Pool — page.evaluate(fetch)로 탭 고정 방식
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
const _poolMax  = 6;
let   _poolInitCount = 0;

// ★ 안전 close — Puppeteer ProtocolError 크래시 완벽 방지 ★
async function safeClose(p) {
  try { await p.close(); } catch(e) {}
}

async function getPoolPage() {
  while (isResetting) { await new Promise(r => setTimeout(r, 500)); }
  // ★ 풀에서 꺼내되, 구세대 페이지는 close 안 함 (browser.close()가 이미 처리) ★
  while (pagePool.length > 0) {
    const p = pagePool.pop();
    if (p._gen === _browserGen) return p;
    // 구세대 → browser.close()가 이미 정리함. close 호출 자체가 ProtocolError 크래시 원인!
  }
  const b = await getBrowser();
  const p = await b.newPage();
  p._gen = _browserGen;

  // ── 봇 탐지 우회 ──
  await p.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR','ko','en-US','en'] });
    Object.defineProperty(navigator, 'plugins',   { get: () => [{name:'Chrome PDF Plugin'},{name:'Chrome PDF Viewer'}] });
    Object.defineProperty(navigator, 'platform',  { get: () => 'iPhone' });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
    window.chrome = { runtime:{}, loadTimes:()=>{}, csi:()=>{}, app:{} };
    const oq = window.navigator.permissions.query;
    window.navigator.permissions.query = p => p.name==='notifications'
      ? Promise.resolve({state:Notification.permission}) : oq(p);
  });

  await p.setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
  );
  await p.setExtraHTTPHeaders({
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Sec-CH-UA-Mobile': '?1',
    'Sec-CH-UA-Platform': '"iOS"',
  });
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  // ★ fetch 방식은 브라우저 쿠키 필요 → 최초 1회 m.naver.com 방문 ★
  try {
    await p.goto('https://m.naver.com', { waitUntil: 'domcontentloaded', timeout: 8000 });
  } catch(e) { /* 초기 방문 실패해도 fetch 시 자동 쿠키 생성됨 */ }

  _poolInitCount++;
  console.log(`  [pool] 탭 #${_poolInitCount} 생성 (gen=${_browserGen})`);
  return p;
}

function returnPage(p) {
  if (!p) return;
  // ★ 구세대/리셋 중 → close 하지 않음! browser.close()가 이미 정리함 ★
  // page.close()가 이미 죽은 브라우저에서 ProtocolError 크래시 일으키므로 절대 close 안 함
  if (p._gen !== _browserGen || isResetting) return;
  if (pagePool.length < _poolMax) {
    pagePool.push(p);
  } else {
    safeClose(p); // ★ 안전 close (try-catch 감싸진 함수) ★
  }
}

// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// 신지도/구지도 분류 — v6: "저장" 카운트 + 필터 키워드 (HTML 정규식, 0ms)
// ──────────────────────────────────────────────────────────
// ★ 핵심 발견 (마케팅 업계 공식 구분법):
//   구지도: 필터X, 저장X — 지도 바로 아래 단순 리스트
//   신지도: 필터O, 저장O — 각 업체 카드마다 "저장" 버튼 존재
//
// ★ v6 판별 방식:
//   fetch로 받은 HTML 텍스트에서 즉시 정규식 검색 (렌더링 대기 0ms)
//   - "저장" 텍스트 3회 이상 = 신지도 (각 카드 × 저장 버튼)
//   - 실제 HTML 태그(class="place_filter" 등) 존재 = 신지도
//   - 둘 다 없으면 = 구지도
// ══════════════════════════════════════════════════════════

function normName(s) {
  return (s||'').replace(/\s+/g,'').toLowerCase();
}

// ══════════════════════════════════════════════════════════
// ★★★ 독립 파싱 함수 (page.evaluate 밖에서도 사용 가능) ★★★
// ══════════════════════════════════════════════════════════

function norm(s) { return (s||'').replace(/\s+/g,'').toLowerCase(); }

// ★ 균형 괄호 추출 — lazy regex의 JSON 절단 문제 해결 ★
// {[\s\S]+?} 는 첫 번째 } 에서 멈춰서 중첩 JSON을 잘라버림
// 이 함수는 { } 를 카운팅하여 올바른 짝을 찾음
function extractBalancedJSON(str, startIdx) {
  if (!str || startIdx < 0 || startIdx >= str.length) return null;
  const open = str[startIdx];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  const end = Math.min(str.length, startIdx + 500000);
  for (let i = startIdx; i < end; i++) {
    const c = str[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0 && c === close) return str.slice(startIdx, i + 1);
    }
  }
  return null;
}

// script 텍스트에서 패턴 뒤의 균형 JSON을 안전하게 추출
function safeExtractJSON(txt, pattern) {
  const results = [];
  let m;
  pattern.lastIndex = 0;
  while ((m = pattern.exec(txt)) !== null) {
    // = 뒤의 { 또는 [ 위치 찾기
    const searchStart = m.index + m[0].length;
    let bracePos = -1;
    for (let i = searchStart - 3; i < Math.min(searchStart + 20, txt.length); i++) {
      if (i < 0) continue;
      if (txt[i] === '{' || txt[i] === '[') { bracePos = i; break; }
    }
    if (bracePos < 0) continue;
    const jsonStr = extractBalancedJSON(txt, bracePos);
    if (!jsonStr || jsonStr.length < 50) continue;
    try {
      const parsed = JSON.parse(jsonStr);
      results.push(parsed);
    } catch(e) {
      // JSON.parse 실패 시 후행 세미콜론/콤마 제거 후 재시도
      const trimmed = jsonStr.replace(/[;,\s]+$/, '');
      try { results.push(JSON.parse(trimmed)); } catch(e2) {}
    }
  }
  return results;
}

function isAdItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.ad === true || item.ad === 'true' || item.ad === 1) return true;
  if (item.isAd === true || item.isAd === 'true') return true;
  if (item.adyn === true || item.adyn === 'Y') return true;
  if (item.isAdItem || item.isPaymentAd || item.isVisitAd) return true;
  if (item.adId || item.adBidId || item.adExposureId || item.adRank) return true;
  if (typeof item.type === 'string' && /^ad$/i.test(item.type)) return true;
  if (typeof item.adType === 'string' && item.adType.length > 0) return true;
  if (typeof item.businessItemType === 'string' && /^AD$/i.test(item.businessItemType)) return true;
  if (typeof item.itemType === 'string' && /ad|sponsor|power/i.test(item.itemType)) return true;
  return false;
}

function extractPlaceItems(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const hits = [];

  // ★ 재귀 속성 탐색 헬퍼: 중첩 객체에서 특정 키의 값을 찾아냄 ★
  function deepFind(obj, keys, maxDepth) {
    if (!obj || typeof obj !== 'object' || (maxDepth||0) > 4) return undefined;
    const d = (maxDepth||0) + 1;
    for (let k = 0; k < keys.length; k++) {
      if (obj[keys[k]] !== undefined && obj[keys[k]] !== null && obj[keys[k]] !== '') return obj[keys[k]];
    }
    // 1단계 중첩 탐색 (place, business, item, commonData, base, detail 등)
    const nested = ['place','business','item','commonData','base','detail','placeDetail','data','info','node'];
    for (let n = 0; n < nested.length; n++) {
      if (obj[nested[n]] && typeof obj[nested[n]] === 'object' && !Array.isArray(obj[nested[n]])) {
        const found = deepFind(obj[nested[n]], keys, d);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

    // ★ ID — 재귀 탐색 ★
    const idKeys = ['id','placeId','businessId','nid','sid','place_id','place_nid','cid','u_cid','placeID','shopId','storeId','entryId','bizId','localId','naverMapId'];
    let idVal = deepFind(item, idKeys, 0) || '';

    // ★ 이름 — 재귀 탐색 ★
    const nameKeys = ['name','title','businessName','placeName','display','shopName','storeName','displayName','placeTitle','itemName'];
    let nameVal = deepFind(item, nameKeys, 0) || '';

    // ★ 주소 — 재귀 탐색 ★
    const addrKeys = ['roadAddress','fullAddress','jibunAddress','streetAddress'];
    let addrVal = deepFind(item, addrKeys, 0) || '';
    if (!addrVal && item.addressInfo) addrVal = item.addressInfo.roadAddress || item.addressInfo.fullAddress || '';
    if (!addrVal && item.address && typeof item.address === 'string') addrVal = item.address;
    if (!addrVal && item.address && typeof item.address === 'object') addrVal = item.address.streetAddress || item.address.roadAddress || item.address.fullAddress || '';

    // ★ 이미지 카운트 — 재귀 탐색 ★
    const imgArrayKeys = ['images','imageList','thumUrls','photos','imageUrls'];
    let imgs = deepFind(item, imgArrayKeys, 0) || [];
    let imgCount = 0;
    if (Array.isArray(imgs)) { imgCount = imgs.length; }
    else if (typeof imgs === 'string' && imgs.length > 10) { imgCount = imgs.split(',').length; }
    if (!imgCount || imgCount <= 1) {
      const imgCountKeys = ['imageCount','imgCount','photoCount','imageLength','totalImageCount','placeImageCount'];
      const ic = parseInt(deepFind(item, imgCountKeys, 0) || 0);
      if (ic > imgCount) imgCount = ic;
    }
    if (!imgCount) {
      const thumbKeys = ['thumUrl','imageUrl','thumbnail','thumbUrl','mainImage','representImage'];
      if (deepFind(item, thumbKeys, 0)) imgCount = 1;
    }

    // ★ 리뷰 시그널 — 재귀 탐색 ★
    let hasReviewSignal = false;
    const reviewSigKeys = ['menuInfo','receiptReview','visitorReviewScore','scoreInfo','reviewTags','microReview','reviewKeywordList','placeReviewCount'];
    for (let rk = 0; rk < reviewSigKeys.length; rk++) {
      const v = deepFind(item, [reviewSigKeys[rk]], 0);
      if (v !== undefined && v !== null && v !== '' && v !== 0 && v !== false) {
        if (Array.isArray(v) ? v.length > 0 : true) { hasReviewSignal = true; break; }
      }
    }

    // ★ 방문자 리뷰 — 재귀 탐색 ★
    let hasVisitorReview = false;
    const rvCountKeys = ['reviewCount','visitorReviewCount','fsVisitorReviewCount','totalReviewCount',
                         'blogCafeReviewCount','bookingReviewCount','cardReviewNum','blogReviewCount',
                         'reviewCnt','placeReviewCount','visitorReviewTotal','saveCnt'];
    for (let rv = 0; rv < rvCountKeys.length; rv++) {
      const v = deepFind(item, [rvCountKeys[rv]], 0);
      if (v && parseInt(v) > 0) { hasVisitorReview = true; break; }
    }

    const rawId = String(idVal);
    const id = rawId.replace(/^[a-z]:/, '');
    const name = String(nameVal).trim();
    if (id.length >= 5 && /^\d+$/.test(id) && name.length >= 1) {
      if (!isAdItem(item)) {
        const rawString = JSON.stringify(item);

        // ★ rawString 폴백: 직접 속성에서 못 찾은 시그널을 JSON 문자열로 탐색 ★
        if (!imgCount) {
          // "imageCount":5 또는 "photoCount":12 패턴
          const icMatch = rawString.match(/"(?:imageCount|imgCount|photoCount|totalImageCount|imageLength)"[:\s]*(\d+)/);
          if (icMatch && parseInt(icMatch[1]) > 0) imgCount = parseInt(icMatch[1]);
        }
        if (!hasReviewSignal) {
          if (/"menuInfo"|"reviewKeywordList"|"receiptReview"|"visitorReviewScore"|"scoreInfo"|"reviewTags"|"microReview"/.test(rawString)) {
            hasReviewSignal = true;
          }
        }
        if (!hasVisitorReview) {
          const rvMatch = rawString.match(/"(?:reviewCount|visitorReviewCount|totalReviewCount|blogCafeReviewCount)"[:\s]*"?(\d+)"?/);
          if (rvMatch && parseInt(rvMatch[1]) > 0) hasVisitorReview = true;
        }

        hits.push({ id, name, addr:String(addrVal), imgCount, hasReviewSignal, hasVisitorReview, rawString });
      }
    }
  }
  return hits.length >= 2 ? hits : null;
}

// ══════════════════════════════════════════════════════════
// ★ APOLLO_STATE __ref 순서 보장 해석기 — Object.keys() 무작위 순회 금지 ★
// ROOT_QUERY 안의 검색 결과 __ref 배열 순서대로 엔티티를 조회하여 순위를 보장
// ══════════════════════════════════════════════════════════
function resolveApolloItems(apolloData) {
  if (!apolloData || typeof apolloData !== 'object') return null;
  const rootQuery = apolloData['ROOT_QUERY'] || apolloData['root_query'];
  if (!rootQuery || typeof rootQuery !== 'object') return null;

  const rqKeys = Object.keys(rootQuery);
  for (let i = 0; i < rqKeys.length; i++) {
    const k = rqKeys[i];
    if (/PlaceList|placeSearch|searchPlace|localSearch|smartAround|nxPlaces|placeList|PlaceBlueLink/i.test(k)) {
      // 광고 키 스킵
      if (/\bad\b|adItem|powerlink|sponsor/i.test(k)) continue;
      const val = rootQuery[k];
      if (!val || typeof val !== 'object') continue;

      // __ref 배열이 들어있을 수 있는 후보 경로
      const candidates = [val.items, val.result, val.data, val.list, val.places, val.businesses, val.edges, val.nodes];
      // val 자체가 배열일 수도 있음
      if (Array.isArray(val)) candidates.unshift(val);

      for (let c = 0; c < candidates.length; c++) {
        const arr = candidates[c];
        if (!Array.isArray(arr) || arr.length < 2) continue;

        // __ref 패턴인지 확인
        const hasRefs = arr[0] && (arr[0].__ref || (arr[0].node && arr[0].node.__ref));
        if (hasRefs) {
          // __ref 배열 순서대로 엔티티 해석 → 순위 보장!
          const resolved = [];
          for (let j = 0; j < arr.length; j++) {
            const refKey = arr[j].__ref || (arr[j].node && arr[j].node.__ref);
            if (typeof refKey === 'string' && apolloData[refKey]) {
              resolved.push(apolloData[refKey]);
            } else if (typeof arr[j] === 'object' && !arr[j].__ref) {
              resolved.push(arr[j]); // 인라인 데이터
            }
          }
          if (resolved.length >= 2) {
            const items = extractPlaceItems(resolved);
            if (items) return items;
          }
        } else {
          // __ref 아닌 직접 데이터 배열
          const items = extractPlaceItems(arr);
          if (items) return items;
        }
      }
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════
// ★ __skt_view_payload__ 파서 — 구지도 노출 순서 100% 보장 ★
// 구지도는 이 페이로드에 검색 결과가 순서대로 들어있음
// ══════════════════════════════════════════════════════════
function parseSktViewPayload(html) {
  // window.__skt_view_payload__ = {...} 패턴 추출
  const sktRe = /window\.__skt_view_payload__\s*=\s*/;
  const sktMatch = html.match(sktRe);
  if (!sktMatch) return null;

  const startIdx = sktMatch.index + sktMatch[0].length;
  // 균형 괄호로 JSON 추출
  let depth = 0, inStr = false, escape = false, endIdx = -1;
  const first = html[startIdx];
  if (first !== '{' && first !== '[') return null;
  const open = first, close = first === '{' ? '}' : ']';
  for (let i = startIdx; i < Math.min(html.length, startIdx + 500000); i++) {
    const ch = html[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open || ch === '{' || ch === '[') depth++;
    if (ch === close || ch === '}' || ch === ']') depth--;
    if (depth === 0) { endIdx = i + 1; break; }
  }
  if (endIdx <= startIdx) return null;

  try {
    const sktData = JSON.parse(html.slice(startIdx, endIdx));
    // skt_view_payload 내부에서 place 배열 찾기
    // 가능한 경로: sktData.result, sktData.items, sktData.place, 재귀 탐색
    const items = findPlaceArray(sktData, 0, 'skt-view');
    return items;
  } catch(e) {
    return null;
  }
}

function findPlaceArray(obj, depth, parentKey) {
  if ((depth||0) > 30 || !obj) return null;
  const d = (depth||0) + 1;
  const pk = String(parentKey||'').toLowerCase();
  if (/\bad\b|aditem|powerlink|sponsor|banner|cm_a|nkw|plcash/i.test(pk)) return null;
  if (Array.isArray(obj) && obj.length >= 2) {
    const items = extractPlaceItems(obj);
    if (items) return items;
    for (let ai = 0; ai < Math.min(obj.length, 40); ai++) {
      const r = findPlaceArray(obj[ai], d, String(ai)); if (r) return r;
    }
  }
  if (typeof obj === 'object' && !Array.isArray(obj)) {
    const keys = Object.keys(obj);
    const tier1 = keys.filter(k => /place|smart_?around|organic|PlaceList|placeList|placeSearch|localSearch|searchResult|blueLink|nxPlaces/i.test(k));
    const tier2 = keys.filter(k => !tier1.includes(k) && /list|items|result|data|search|local|query|queries|documents|entries|contents|nodes|edges/i.test(k));
    const adKeys = keys.filter(k => /\bad\b|aditem|powerlink|sponsor|banner/i.test(k.toLowerCase()));
    const rest = keys.filter(k => !tier1.includes(k) && !tier2.includes(k) && !adKeys.includes(k));
    const ordered = tier1.concat(tier2).concat(rest);
    for (let ki = 0; ki < ordered.length; ki++) {
      const r = findPlaceArray(obj[ordered[ki]], d, ordered[ki]); if (r) return r;
    }
  }
  return null;
}

function findSearchPlaceQuery(obj) {
  if (!obj) return null;
  try {
    // ★ 탐색 경로 극대화 — NEXT_DATA, APOLLO, skt_view, 기타 모든 가능 경로 ★
    const paths = [
      obj.props && obj.props.pageProps && obj.props.pageProps.dehydratedState,
      obj.props && obj.props.pageProps && obj.props.pageProps.initialState,
      obj.props && obj.props.pageProps,
      obj.props && obj.props.initialState,
      obj.props,
      obj.__APOLLO_STATE__,
      obj.ROOT_QUERY,
      obj.data,
      obj.result,
      obj.pageData,
      obj.initialData,
      obj
    ];
    for (let pi = 0; pi < paths.length; pi++) {
      const target = paths[pi]; if (!target) continue;
      // queries/dehydratedQueries 배열 탐색
      const qArrays = [target.queries, target.dehydratedQueries, target.cache];
      for (let qa = 0; qa < qArrays.length; qa++) {
        const queries = qArrays[qa];
        if (!Array.isArray(queries)) continue;
        // 1차: queryKey 정규식
        for (let qi = 0; qi < queries.length; qi++) {
          const q = queries[qi];
          const qKey = JSON.stringify(q.queryKey || q.key || q.queryHash || '');
          if (/SearchPlaceList|PlaceList|place.*list|smart_?around|local.*search|nxPlaces|PlaceBlueLink|placeSearch|localSearch/i.test(qKey)) {
            const data = (q.state && q.state.data) || q.data || q.result;
            if (data) return data;
          }
        }
        // 2차: placeId/businessId 3개 이상 포함
        for (let qi2 = 0; qi2 < queries.length; qi2++) {
          const q2 = queries[qi2];
          const qStr = JSON.stringify(q2);
          if (/powerlink|adItem|AD_ITEM|sponsoredList/i.test(qStr)) continue;
          const idMatches = (qStr.match(/placeId|businessId|"sid"/gi) || []).length;
          if (idMatches >= 3) {
            return (q2.state && q2.state.data) || q2.data || q2;
          }
        }
      }
      // ★ APOLLO_STATE 형식: resolveApolloItems로 __ref 순서 보장 ★
      if (typeof target === 'object' && !Array.isArray(target) && target['ROOT_QUERY']) {
        // APOLLO는 별도 해석기로 처리 (findPlaceArray 대신)
        // findSearchPlaceQuery는 null 반환 → 호출측에서 resolveApolloItems 사용
        return null;
      }
      // 비-APOLLO 객체에서 PlaceList 키 탐색
      if (typeof target === 'object' && !Array.isArray(target)) {
        const tKeys = Object.keys(target);
        for (let tk = 0; tk < tKeys.length; tk++) {
          const k = tKeys[tk];
          if (/PlaceList|placeSearch|searchPlace|localSearch|smartAround/i.test(k)) {
            if (/ROOT_QUERY/i.test(k)) continue; // APOLLO는 위에서 처리
            const val = target[k];
            if (val && typeof val === 'object') return val;
          }
        }
      }
    }
  } catch(e) {}
  return null;
}

function matchRank(items, pid, nb, biz, tAddr) {
  const limit = Math.min(items.length, 10);
  for (let i = 0; i < limit; i++) {
    if (items[i].id === pid) return { rank: i+1, method: 'id' };
  }
  for (let i = 0; i < limit; i++) {
    if (items[i].rawString && items[i].rawString.indexOf(pid) !== -1) return { rank: i+1, method: 'deep-id' };
  }
  if (nb.length >= 4) {
    for (let i = 0; i < limit; i++) {
      const rn = norm(items[i].name);
      if (rn.length >= 4 && rn.indexOf(nb) === 0) {
        const branchKws = [
          // 일반 분점 지칭
          '본점','직영','직영점','1호점','2호점','3호점','4호점','5호점',
          // 서울
          '강남','서초','잠실','송파','홍대','합정','연남','마포','신촌','이대','건대','성수','왕십리',
          '종로','광화문','을지로','명동','동대문','혜화','대학로','이태원','용산','한남','삼성','역삼',
          '선릉','논현','청담','압구정','신사','가로수길','여의도','영등포','당산','목동','양천',
          '노원','도봉','강북','미아','창동','상봉','중랑','면목','천호','길동','강동','고덕',
          '사당','방배','신림','봉천','관악','동작','흑석','구로','신도림','가산','금천','독산',
          '상암','수색','은평','서대문','연희','불광',
          // 경기/인천
          '분당','판교','수지','광교','영통','수원','동탄','평택','일산','파주','김포',
          '인천','부평','송도','청라','검단','구월','하남','위례','미사','광명','안양','의왕',
          '성남','용인','화성','시흥','안산','군포',
          // 부산
          '서면','마린시티','시청','센텀','광안리','해운대','부산대','사상','하단','동래',
          '연산','남포','자갈치','중앙','전포','부전','양정','범일','범천','남천','경성대',
          '대연','용호','기장','정관','수영','광안','민락','다대포',
          // 대구
          '동성로','수성','범어','만촌','황금','시지','달서','성서','월성','두류','죽전',
          // 대전
          '둔산','유성','궁동','봉명','탄방','관저','노은','도안',
          // 광주
          '충장로','상무','수완','첨단','봉선','운암','금남로',
          // 기타 광역시/주요도시
          '울산','창원','마산','진해','김해','양산','진주','포항','경주','구미',
          '전주','익산','군산','목포','여수','순천','춘천','원주','강릉','속초',
          '제주','서귀포','연동','노형','중문','애월',
        ];
        const fullName = items[i].name;
        let isBranch = false;
        for (let bk = 0; bk < branchKws.length; bk++) {
          if (fullName.indexOf(branchKws[bk]) !== -1) { isBranch = true; break; }
        }
        if (isBranch && tAddr) {
          for (let bk2 = 0; bk2 < branchKws.length; bk2++) {
            if (fullName.indexOf(branchKws[bk2]) !== -1 && tAddr.indexOf(branchKws[bk2]) !== -1) { isBranch = false; break; }
          }
        }
        if (isBranch) continue;
        if (tAddr && items[i].addr) {
          const tGu = (tAddr.match(/([가-힣]{2,4}구)/) || [])[1];
          if (tGu && items[i].addr.indexOf(tGu) === -1) continue;
        }
        return { rank: i+1, method: 'name-prefix' };
      }
    }
  }
  return { rank: null, method: 'none' };
}

// ══════════════════════════════════════════════════════════
// ★★★ checkRankFast — Browser-Internal Fetch 기반 (탭 고정, 렌더링 없음) ★★★
// ══════════════════════════════════════════════════════════
// 탭은 m.naver.com에 고정 → page.evaluate(fetch)로 HTML만 받아옴
// → 서버사이드 JSON 파싱 → 0ms mapType 판별 (렌더링 대기 없음)

async function checkRankFast(keyword, bizName, placeId, bizAddress) {
  const pid = String(placeId);
  const nb  = normName(bizName);
  const addr = bizAddress || '';

  let page = null;
  try {
    page = await getPoolPage();

    // ★ Browser-Internal Fetch — 탭 고정, 렌더링 없음 ★
    // page.evaluate(fetch)로 HTML만 받아옴 → 리소스 차단 불필요

    // ★ 랜덤 딜레이 (최소화 — headless:'new'로 캡챠 해결) ★
    await new Promise(r => setTimeout(r, 500 + Math.random() * 500));

    const searchUrl = 'https://m.search.naver.com/search.naver?sm=mtb_hty.top&where=m&query=' + encodeURIComponent(keyword);

    // ★ page.evaluate(fetch) — 브라우저 내부 백그라운드 fetch (탭 고정, 렌더링 없음) ★
    // 탭은 m.naver.com에 고정 → fetch로 HTML 텍스트만 받아옴 → 초고속 + 스텔스
    let html = '';
    try {
      html = await page.evaluate(async (url) => {
        try {
          const res = await fetch(url, { credentials: 'include' });
          return await res.text();
        } catch(e) { return ''; }
      }, searchUrl);
    } catch(e) {
      html = '';
    }

    if (!html || html.length < 500) {
      // ★ 빈 페이지 = 소프트 블락 가능성 → loadFail:true → 리셋 트리거 ★
      return { rank: null, mapType: null, loadFail: true, method: 'fast-empty' };
    }

    // ★ 캡챠/차단 감지 — 오탐 방지: 짧은 페이지 + 캡챠 마커 + 검색결과 없음 ★
    const hasSearchContent = /__NEXT_DATA__|place_section|place-main-section|PlaceItem|placeId|"items"|"businesses"/i.test(html);
    if (!hasSearchContent) {
      if (/보안문자|자동입력방지|비정상적인\s*접근|unusual\s*traffic|blocked/i.test(html) && html.length < 30000) {
        console.log(`  ⚠️ [CAPTCHA] "${keyword}" — 네이버 캡챠/차단 감지! (len=${html.length})`);
        consecutiveFailCount = FAIL_THRESHOLD;
        return { rank: null, mapType: null, loadFail: true, method: 'fast-captcha' };
      }
    }

    // ★ 빈 검색 결과 — 정상 (플레이스 영역 없는 키워드) ★
    if (html.length < 3000 && !/place\.naver\.com|placeId|businessId/i.test(html)) {
      return { rank: null, mapType: null, loadFail: false, method: 'fast-no-place-section' };
    }

    let items = null;

    // ══════════════════════════════════════════════════════════════
    // ★ 1순위: __skt_view_payload__ (구지도 노출 순서 100% 보장) ★
    // ══════════════════════════════════════════════════════════════
    items = parseSktViewPayload(html);

    // ══════════════════════════════════════════════════════════════
    // 2순위: __NEXT_DATA__ (SSR 기본 데이터)
    // ══════════════════════════════════════════════════════════════
    if (!items) {
      const ndMatch = html.match(/<script[^>]*id\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
      if (ndMatch) {
        try {
          const nd = JSON.parse(ndMatch[1]);
          const pq = findSearchPlaceQuery(nd);
          if (pq) items = findPlaceArray(pq, 0, 'placeQuery');
          if (!items) items = findPlaceArray(nd, 0, 'nextdata');
        } catch(e) {}
      }
    }

    // ══════════════════════════════════════════════════════════════
    // ★ 3순위: __APOLLO_STATE__ — ROOT_QUERY의 __ref 배열 순서 보장 ★
    // Object.keys() 무작위 순회 금지 → __ref 배열 순서대로 엔티티 해석
    // ══════════════════════════════════════════════════════════════
    if (!items) {
      // APOLLO_STATE 추출: window.__APOLLO_STATE__ = {...} 패턴
      const apolloRe = /window\.__APOLLO_STATE__\s*=\s*/;
      const apolloMatch = html.match(apolloRe);
      if (apolloMatch) {
        try {
          const aIdx = apolloMatch.index + apolloMatch[0].length;
          const apolloResults = safeExtractJSON(html.slice(Math.max(0,aIdx-apolloMatch[0].length)), apolloRe);
          for (let ai = 0; !items && ai < apolloResults.length; ai++) {
            items = resolveApolloItems(apolloResults[ai]);
          }
        } catch(e) {}
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 전략2: 모든 script 태그 전수 스캔 (APOLLO, skt_view, application/json 등)
    // ══════════════════════════════════════════════════════════════
    if (!items) {
      // 2-A: <script type="application/json"> 태그 (id 무관)
      const appJsonRe = /<script[^>]*type\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
      let ajm;
      while (!items && (ajm = appJsonRe.exec(html)) !== null) {
        const txt = ajm[1];
        if (txt.length < 100) continue;
        try {
          const ajData = JSON.parse(txt);
          const pq = findSearchPlaceQuery(ajData);
          if (pq) items = findPlaceArray(pq, 0, 'app-json-query');
          if (!items) items = findPlaceArray(ajData, 0, 'app-json');
        } catch(e) {}
      }
    }

    if (!items) {
      // 2-B: 모든 인라인 script 태그 전수 스캔
      const allScriptRe = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
      let sm;
      while (!items && (sm = allScriptRe.exec(html)) !== null) {
        const txt = sm[1];
        if (txt.length < 150) continue;
        // 플레이스 관련 키워드가 포함된 스크립트만 깊이 파싱
        if (!/placeId|businessId|"sid"|place_id|placeList|place_nid|PlaceItem|SearchPlace|localSearch|smartAround|naver\.com\/place|"rank"|"imageCount"|reviewCount/i.test(txt)) continue;

        // 방법1: 전체가 JSON인 경우
        try {
          const data = JSON.parse(txt);
          const pq = findSearchPlaceQuery(data);
          if (pq) items = findPlaceArray(pq, 0, 'script-query');
          if (!items) items = findPlaceArray(data, 0, 'script-full');
          if (items) break;
        } catch(e) {}

        // 방법2: window.__XXXX__ = {...} 패턴 ★균형 괄호 추출★
        if (!items) {
          const winRe = /window\.__([A-Za-z0-9_]+)__\s*=/gi;
          const winResults = safeExtractJSON(txt, winRe);
          for (let wi = 0; !items && wi < winResults.length; wi++) {
            const pq = findSearchPlaceQuery(winResults[wi]);
            if (pq) items = findPlaceArray(pq, 0, 'window-balanced');
            if (!items) items = findPlaceArray(winResults[wi], 0, 'window-balanced');
          }
        }

        // 방법3: window.xxx = {...} (언더스코어 없는 변수)
        if (!items) {
          const winPlainRe = /window\.([A-Za-z_]\w+)\s*=/gi;
          const winPlainResults = safeExtractJSON(txt, winPlainRe);
          for (let wp = 0; !items && wp < winPlainResults.length; wp++) {
            const pq = findSearchPlaceQuery(winPlainResults[wp]);
            if (pq) items = findPlaceArray(pq, 0, 'window-plain');
            if (!items) items = findPlaceArray(winPlainResults[wp], 0, 'window-plain');
          }
        }

        // 방법4: var/const/let xxx = {...} ★균형 괄호 추출★
        if (!items) {
          const varAssignRe = /(?:var|let|const)\s+[A-Za-z_]\w*\s*=/gi;
          const varResults = safeExtractJSON(txt, varAssignRe);
          for (let vi = 0; !items && vi < varResults.length; vi++) {
            items = findPlaceArray(varResults[vi], 0, 'var-balanced');
          }
        }

        // 방법5: 일반 할당 xxx = {...} (200자 이상 JSON)
        if (!items) {
          const assignRe = /[A-Za-z_]\w*\s*=\s*(?=[\{\[])/gi;
          const assignResults = safeExtractJSON(txt, assignRe);
          for (let ai = 0; !items && ai < assignResults.length; ai++) {
            items = findPlaceArray(assignResults[ai], 0, 'assign-balanced');
          }
        }

        if (items) break;
      }
    }

    // ══════════════════════════════════════════════════════════════
    // ══════════════════════════════════════════════════════════════
    // ★ HTML 섹션 격리 — 광고/추천 영역 제거, 유기적 플레이스만 추출 ★
    // ══════════════════════════════════════════════════════════════
    // 네이버 모바일 검색 HTML 구조: [파워링크] [플레이스(유기적)] [블로그] [카페] ...
    // 광고 섹션을 제거하고 유기적 플레이스 영역만 남긴다
    let organicHtml = html;
    {
      // 광고 섹션 제거: <div> ~ </div> 블록 중 광고 키워드 포함된 것
      const adSectionRe = /<(?:div|section|ul)[^>]*class="[^"]*(?:ad_area|power_link|spns|sponsor|_ad_|plc_adpk|sc_ad)[^"]*"[^>]*>[\s\S]*?<\/(?:div|section|ul)>/gi;
      organicHtml = organicHtml.replace(adSectionRe, '');
      // "파워링크" 텍스트 주변 500자 블록 제거
      organicHtml = organicHtml.replace(/[\s\S]{0,200}파워링크[\s\S]{0,300}/g, (match) => {
        // 해당 블록에서 place ID가 있으면 통째로 제거
        if (/place\/\d{5,15}/.test(match)) return '';
        return match;
      });
      // searchad, adcr 링크 주변 블록 제거
      organicHtml = organicHtml.replace(/<[^>]*(?:searchad\.naver|adcr\.naver|ad\.search\.naver)[^>]*>[\s\S]{0,500}?<\/[^>]+>/gi, '');
    }

    // 전략3: 유기적 HTML에서 place ID 링크 + 카드별 시그널 추출
    // ══════════════════════════════════════════════════════════════
    if (!items) {
      const linkRe = /(?:place\.naver\.com|map\.naver\.com)\/(?:place|restaurant|hairshop|hospital|accommodation|p\/entry\/place)\/(\d{5,15})/g;
      const seen = {}, linkItems = [];
      let lm;
      // ★ organicHtml에서만 스캔 (광고 제거된 HTML) ★
      while ((lm = linkRe.exec(organicHtml)) !== null) {
        if (!seen[lm[1]]) {
          // 매칭 위치 주변 500자 컨텍스트 확인 — 광고 근접 여부 체크
          const pos = lm.index;
          const ctx = organicHtml.slice(Math.max(0, pos - 300), Math.min(organicHtml.length, pos + 300));
          if (/광고|파워링크|powerlink|searchad\.naver|adcr\.naver|ad\.search\.naver|sponsor/i.test(ctx)) continue;

          seen[lm[1]] = true;

          // ★ 카드 컨텍스트에서 시그널 직접 추출 ★
          const cardCtx = organicHtml.slice(Math.max(0, pos - 500), Math.min(organicHtml.length, pos + 1500));
          let cardImgCount = 0;
          let cardHasReview = false;
          let cardHasVisitor = false;
          // 이미지: <img 태그 수 또는 "imageCount":N
          const imgTags = (cardCtx.match(/<img[^>]+>/gi) || []).length;
          const imgCountMatch = cardCtx.match(/"(?:imageCount|imgCount|photoCount)"[:\s]*(\d+)/);
          cardImgCount = imgCountMatch ? parseInt(imgCountMatch[1]) : Math.min(imgTags, 5);
          // 리뷰 시그널
          if (/"menuInfo"|"reviewKeywordList"|"scoreInfo"|"microReview"/.test(cardCtx)) cardHasReview = true;
          if (/방문자리뷰|블로그리뷰|별점|이런\s*점이\s*좋아요/i.test(cardCtx)) cardHasReview = true;
          if (/"(?:reviewCount|visitorReviewCount|totalReviewCount)"[:\s]*"?([1-9]\d*)"?/.test(cardCtx)) cardHasVisitor = true;

          linkItems.push({ id:lm[1], name:'', addr:'', imgCount:cardImgCount, hasReviewSignal:cardHasReview, hasVisitorReview:cardHasVisitor, rawString:cardCtx.slice(0,500) });
        }
      }
      if (linkItems.length >= 2) {
        const _pp = '(?:place|restaurant|hairshop|hospital|accommodation)/';
        for (let li = 0; li < linkItems.length; li++) {
          const pid2 = linkItems[li].id;
          // 이름 추출 (organicHtml에서)
          const nameRe = new RegExp(_pp + pid2 + '[\\s\\S]{0,500}?class="[^"]*(?:place_bluelink|YwYLL|TYaxT|title)[^"]*"[^>]*>([^<]{2,40})<','i');
          const nm = organicHtml.match(nameRe);
          if (nm) { linkItems[li].name = nm[1].trim(); continue; }
          const ariaRe = new RegExp(_pp + pid2 + '[\\s\\S]{0,300}?aria-label="([^"]{2,40})"','i');
          const am = organicHtml.match(ariaRe);
          if (am) { linkItems[li].name = am[1].trim(); continue; }
          const genericRe = new RegExp('<a[^>]*href="[^"]*' + _pp + pid2 + '[^"]*"[^>]*>\\s*(?:<[^>]+>)*\\s*([^<]{2,40}?)\\s*(?:<|$)','i');
          const gm = organicHtml.match(genericRe);
          if (gm) { linkItems[li].name = gm[1].trim(); continue; }
          const nearRe = new RegExp(_pp + pid2 + '[\\s\\S]{0,200}?>([가-힣a-zA-Z0-9][^<]{1,30})<','i');
          const nrm = organicHtml.match(nearRe);
          if (nrm) { linkItems[li].name = nrm[1].trim(); }
        }
        if (linkItems.length >= 2) items = linkItems;
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 전략4: 유기적 HTML에서 ID+이름 쌍 (광고 컨텍스트 제외)
    // ══════════════════════════════════════════════════════════════
    if (!items) {
      const pairRe = /["'](?:id|placeId|businessId|nid|sid|shopId|storeId|entryId|bizId)["']\s*:\s*["']?(\d{5,15})["']?[\s\S]{0,400}?["'](?:name|title|businessName|placeName|displayName|shopName|storeName)["']\s*:\s*["']([^"']{2,40})["']/g;
      const pairs = [], pairSeen = {};
      let pm;
      // ★ organicHtml에서만 스캔 ★
      while ((pm = pairRe.exec(organicHtml)) !== null) {
        // 매칭 컨텍스트에서 광고 여부 확인
        const pos = pm.index;
        const ctx = organicHtml.slice(Math.max(0, pos - 200), Math.min(organicHtml.length, pos + 200));
        if (/광고|파워링크|powerlink|"isAd"\s*:\s*true|"adyn"\s*:\s*"Y"|"adId"|"adBidId"/i.test(ctx)) continue;
        if (!pairSeen[pm[1]]) {
          pairSeen[pm[1]] = true;
          // 카드 시그널 추출
          const cardCtx = organicHtml.slice(Math.max(0, pos - 200), Math.min(organicHtml.length, pos + 1000));
          let ci = 0, cr = false, cv = false;
          const icm = cardCtx.match(/"(?:imageCount|imgCount|photoCount)"[:\s]*(\d+)/);
          if (icm) ci = parseInt(icm[1]);
          if (/"menuInfo"|"reviewKeywordList"|"scoreInfo"/.test(cardCtx)) cr = true;
          if (/"(?:reviewCount|visitorReviewCount)"[:\s]*"?([1-9]\d*)"?/.test(cardCtx)) cv = true;
          pairs.push({ id:pm[1], name:pm[2].trim(), addr:'', imgCount:ci, hasReviewSignal:cr, hasVisitorReview:cv, rawString:cardCtx.slice(0,500) });
        }
      }
      // 역순 (이름→ID)
      if (pairs.length < 2) {
        const revRe = /["'](?:name|title|businessName|placeName)["']\s*:\s*["']([^"']{2,40})["'][\s\S]{0,400}?["'](?:id|placeId|businessId|sid)["']\s*:\s*["']?(\d{5,15})["']?/g;
        let rm;
        while ((rm = revRe.exec(organicHtml)) !== null) {
          const pos = rm.index;
          const ctx = organicHtml.slice(Math.max(0, pos - 200), Math.min(organicHtml.length, pos + 200));
          if (/광고|파워링크|powerlink|"isAd"\s*:\s*true|"adyn"\s*:\s*"Y"/i.test(ctx)) continue;
          if (!pairSeen[rm[2]]) {
            pairSeen[rm[2]] = true;
            pairs.push({ id:rm[2], name:rm[1].trim(), addr:'', imgCount:0, hasReviewSignal:false, hasVisitorReview:false, rawString:'' });
          }
        }
      }
      if (pairs.length >= 2) items = pairs;
    }

    // 전략5 삭제 — 타겟 ID 직접 검색은 광고 구분 불가능하므로 제거

    if (!items || items.length < 1) {
      // ★ 페이지 자체는 정상 로딩됨 → loadFail:false (리셋 트리거 안 됨) ★
      // 플레이스/지도 섹션이 없는 키워드 (예: "비빔밥 레시피")는 정상 동작
      return { rank: null, mapType: null, loadFail: false, method: 'fast-no-items' };
    }

    // ★ 광고 필터링 ★
    items = items.filter(it => !isAdItem(it));

    const m = matchRank(items, pid, nb, bizName, addr);

    if (!m.rank || m.rank > 5) {
      console.log(`  [fast:${m.method}] rank=null total=${items.length} ${(items.slice(0,3).map((x,i)=>(i+1)+'.'+x.name+'('+x.id.slice(-4)+')')).join(' | ')}`);
      return { rank: null, mapType: null, loadFail: false, method: 'fast-' + m.method };
    }

    // ★★★ 신/구지도 판별 — v6: HTML 텍스트 정규식 즉시 판별 (0ms) ★★★
    // 구지도: 필터X, 저장X → HTML에 "저장" 버튼 텍스트 거의 없음
    // 신지도: 필터O, 저장O → 각 카드마다 "저장" 버튼 → HTML에 3회+ 등장
    // 단순 문자열이 아닌, 실제 HTML 태그(class="...")로 존재하는 필터/저장 버튼만 감지
    const hasFilterTag = /<[^>]+class="[^"]*(?:place_filter|sc_filter|loc_filter|filter_wrap|filter_area|btn_filter|filter_item)[^"]*"[^>]*>/i.test(html);
    const hasSaveBtnTag = /<[^>]+class="[^"]*(?:btn_save|save_btn|place_save)[^"]*"[^>]*>/i.test(html);
    const mapType = (hasFilterTag || hasSaveBtnTag) ? 'new' : 'old';

    console.log(`  [fast:${m.method}] rank=${m.rank} mapType=${mapType} total=${items.length} ${(items.slice(0,3).map((x,i)=>(i+1)+'.'+x.name+'('+x.id.slice(-4)+')')).join(' | ')}`);

    return { rank: m.rank, mapType, loadFail: false, method: 'fast-' + m.method };

  } catch(e) {
    console.error('  checkRankFast err:', e.message?.slice(0, 80));
    return { rank: null, mapType: null, loadFail: true, method: 'fast-err' };
  } finally {
    // ★ 풀 반환 (어떤 경로든 반드시 실행) ★
    if (page) {
      try { page.removeAllListeners('request'); } catch(e) {}
      returnPage(page);
    }
  }
}

// ══════════════════════════════════════════════════════════
// ★★★ checkRankLegacy — Puppeteer 기반 (폴백 전용) ★★★
// ══════════════════════════════════════════════════════════

async function checkRankLegacy(keyword, bizName, placeId, bizAddress) {
  const page = await getPoolPage();
  try {
    const pid = String(placeId);
    const nb  = normName(bizName);
    const addr = bizAddress || '';

    // ★★★ 터보 모드: 리소스 차단으로 페이지 로딩 극한 최적화 ★★★
    await page.setRequestInterception(true);
    const _reqHandler = (req) => {
      const rType = req.resourceType();
      // image, stylesheet, font, media 차단 → DOM 구조만 로드
      if (['image','stylesheet','font','media','texttrack','eventsource'].includes(rType)) {
        req.abort();
      } else {
        req.continue();
      }
    };
    page.on('request', _reqHandler);

    // ★ 랜덤 딜레이 (봇 차단 방지) ★
    await new Promise(r => setTimeout(r, 200 + Math.random() * 200));

    // ★★★ page.goto()로 모바일 검색 직접 이동 ★★★
    const searchUrl = 'https://m.search.naver.com/search.naver?sm=mtb_hty.top&where=m&query=' + encodeURIComponent(keyword);
    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const curUrl = page.url();
      if (curUrl && !curUrl.includes('m.search') && !curUrl.includes('m.naver')) {
        console.log(`  [redirect-fix] PC로 리다이렉트 감지 → 모바일 재요청`);
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      }
    } catch(navErr) {
      console.log(`  [goto-retry] ${keyword} → 재시도...`);
      await new Promise(r => setTimeout(r, 800));
      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch(navErr2) {
        page.removeAllListeners('request');
        await page.setRequestInterception(false).catch(()=>{});
        return { rank: null, mapType: null, loadFail: true };
      }
    }

    // ★★★ 스마트 대기: place 카드 + img/리뷰 로딩 감지 ★★★
    // (1) 플레이스 영역 뼈대 대기 (최대 3초)
    await page.waitForSelector('[class*="place_section"], [class*="PlaceItem"], [class*="place_item"], li[class*="item"]', { timeout: 3000 }).catch(() => null);

    // (2) 스크롤 → Lazy Loading 트리거
    await page.evaluate(() => window.scrollBy(0, 800));

    // (3) ★ 스마트 대기: img 태그 또는 리뷰 텍스트 등장까지 최대 2초 ★
    //     (고정 1200ms 대신, 콘텐츠 감지 시 즉시 종료)
    await page.waitForFunction((targetPid) => {
      // 타겟 ID 링크가 있는 카드를 찾고, 내부에 img가 로드되었는지 확인
      const links = document.querySelectorAll('a[href*="place/' + targetPid + '"], a[href*="restaurant/' + targetPid + '"], a[href*="hairshop/' + targetPid + '"]');
      if (links.length === 0) {
        // 타겟 못 찾음 → 다른 카드라도 img/썸네일 컨테이너가 있으면 종료
        const anyImgs = document.querySelectorAll('[class*="PlaceItem"] img, [class*="place_item"] img, li[class*="item"] img');
        if (anyImgs.length >= 2) return true;
        // img 없어도 썸네일 컨테이너가 있으면 리소스 차단 상태 → 진행
        const anyThumbs = document.querySelectorAll('[class*="PlaceItem"] [class*="thumb"], [class*="PlaceItem"] [class*="image"], [class*="place_item"] [class*="thumb"]');
        return anyThumbs.length >= 2;
      }
      // 타겟 카드 찾음 → 부모 li에서 img/썸네일 확인
      const card = links[0].closest('li, [class*="item"], [class*="PlaceItem"]');
      if (!card) return true;
      const imgs = card.querySelectorAll('img');
      if (imgs.length >= 1) return true;
      const thumbs = card.querySelectorAll('[class*="image"], [class*="thumb"], [class*="photo"], [class*="thmb"]');
      if (thumbs.length >= 1) return true; // 썸네일 컨테이너만 있어도 진행
      const txt = card.innerText || '';
      if (/방문자리뷰|블로그리뷰|별점/i.test(txt)) return true;
      return false;
    }, { timeout: 2000 }, pid).catch(() => null);

    // (4) 스크롤 복원
    await page.evaluate(() => window.scrollTo(0, 0));

    // ★★★ page.evaluate()로 DOM에서 직접 파싱 ★★★
    const result = await page.evaluate((targetPid, targetNb, targetBizName, targetAddr) => {

      function norm(s) { return (s||'').replace(/\s+/g,'').toLowerCase(); }

      // ★ 균형 괄호 추출 (Legacy용) ★
      function extractBalancedJSON(str, startIdx) {
        if (!str || startIdx < 0 || startIdx >= str.length) return null;
        var open = str[startIdx];
        if (open !== '{' && open !== '[') return null;
        var close = open === '{' ? '}' : ']';
        var depth = 0, inStr = false, esc = false;
        var end = Math.min(str.length, startIdx + 500000);
        for (var i = startIdx; i < end; i++) {
          var c = str[i];
          if (esc) { esc = false; continue; }
          if (c === '\\' && inStr) { esc = true; continue; }
          if (c === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (c === '{' || c === '[') depth++;
          else if (c === '}' || c === ']') {
            depth--;
            if (depth === 0 && c === close) return str.slice(startIdx, i + 1);
          }
        }
        return null;
      }
      function safeExtractJSON(txt, pattern) {
        var results = [];
        var m;
        pattern.lastIndex = 0;
        while ((m = pattern.exec(txt)) !== null) {
          var searchStart = m.index + m[0].length;
          var bracePos = -1;
          for (var i = searchStart - 3; i < Math.min(searchStart + 20, txt.length); i++) {
            if (i < 0) continue;
            if (txt[i] === '{' || txt[i] === '[') { bracePos = i; break; }
          }
          if (bracePos < 0) continue;
          var jsonStr = extractBalancedJSON(txt, bracePos);
          if (!jsonStr || jsonStr.length < 50) continue;
          try { results.push(JSON.parse(jsonStr)); } catch(e) {
            try { results.push(JSON.parse(jsonStr.replace(/[;,\s]+$/, ''))); } catch(e2) {}
          }
        }
        return results;
      }

      // ── 광고 필터 ──
      function isAdItem(item) {
        if (!item || typeof item !== 'object') return false;
        if (item.ad === true || item.ad === 'true' || item.ad === 1) return true;
        if (item.isAd === true || item.isAd === 'true') return true;
        if (item.adyn === true || item.adyn === 'Y') return true;
        if (item.isAdItem || item.isPaymentAd || item.isVisitAd) return true;
        if (item.adId || item.adBidId || item.adExposureId || item.adRank) return true;
        if (typeof item.type === 'string' && /^ad$/i.test(item.type)) return true;
        if (typeof item.adType === 'string' && item.adType.length > 0) return true;
        if (typeof item.businessItemType === 'string' && /^AD$/i.test(item.businessItemType)) return true;
        if (typeof item.itemType === 'string' && /ad|sponsor|power/i.test(item.itemType)) return true;
        return false;
      }

      // ── 플레이스 아이템 추출 (주소·이미지·리뷰 시그널 포함) ──
      function extractPlaceItems(arr) {
        if (!Array.isArray(arr) || arr.length < 2) return null;
        var hits = [];
        for (var i = 0; i < arr.length; i++) {
          var item = arr[i];
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          var idVal = item.id || item.placeId || item.businessId || item.nid
            || item.place_id || item.sid || item.place_nid || item.cid || item.u_cid || '';
          var nameVal = item.name || item.title || item.businessName || item.placeName
            || item.display || item.shopName || item.storeName || '';
          var addrVal = item.roadAddress || item.fullAddress || item.jibunAddress || item.streetAddress || '';
          if (!addrVal && item.addressInfo) addrVal = item.addressInfo.roadAddress || item.addressInfo.fullAddress || '';
          if (!addrVal && item.address && typeof item.address === 'string') addrVal = item.address;
          if (!addrVal && item.address && typeof item.address === 'object') addrVal = item.address.streetAddress || item.address.roadAddress || '';
          // 이미지 — 직속 속성만 인정
          var imgs = item.images || item.imageList || item.thumUrls || item.photos || item.imageUrls || [];
          var imgCount = 0;
          if (Array.isArray(imgs)) {
            imgCount = imgs.length;
          } else if (typeof imgs === 'string' && imgs.length > 10) {
            imgCount = imgs.split(',').length;
          }
          // ★ 핵심: imageCount 숫자 필드 (네이버는 images 배열 대신 이걸 씀)
          if (!imgCount || imgCount <= 1) {
            var ic = parseInt(item.imageCount || item.imgCount || item.photoCount || item.imageLength || 0);
            if (ic > imgCount) imgCount = ic;
          }
          if (!imgCount && item.thumUrl) imgCount = 1;
          if (!imgCount && item.imageUrl) imgCount = 1;
          // ★ 리뷰 시그널 — 직속 속성만 인정 (rawStr 정규식 금지!)
          var hasReviewSignal = false;
          if (item.menuInfo) hasReviewSignal = true; // 객체든 문자열이든 존재 자체로 신지도
          if (!hasReviewSignal && item.reviewKeywordList) {
            if (Array.isArray(item.reviewKeywordList) ? item.reviewKeywordList.length > 0 : !!item.reviewKeywordList) hasReviewSignal = true;
          }
          if (!hasReviewSignal && item.receiptReview) hasReviewSignal = true;
          if (!hasReviewSignal && item.visitorReviewScore) hasReviewSignal = true;
          if (!hasReviewSignal && item.scoreInfo) hasReviewSignal = true;
          if (!hasReviewSignal && item.reviewTags) hasReviewSignal = true;
          // ★ 방문자 리뷰 — parseInt로 문자열 숫자("123")도 잡기
          var hasVisitorReview = false;
          var rvFields = [item.reviewCount, item.visitorReviewCount, item.fsVisitorReviewCount,
                          item.totalReviewCount, item.blogCafeReviewCount, item.bookingReviewCount,
                          item.cardReviewNum, item.blogReviewCount, item.reviewCnt];
          for (var rv = 0; rv < rvFields.length; rv++) {
            if (rvFields[rv] && parseInt(rvFields[rv]) > 0) { hasVisitorReview = true; break; }
          }
          if (!hasVisitorReview && item.scoreInfo && parseInt(item.scoreInfo.reviewCount || item.scoreInfo.count || 0) > 0) hasVisitorReview = true;
          var rawId = String(idVal);
          var id = rawId.replace(/^[a-z]:/, '');
          var name = String(nameVal).trim();
          if (id.length >= 5 && /^\d+$/.test(id) && name.length >= 1) {
            if (!isAdItem(item)) {
              // ★ rawString = deep-id 매칭 전용. 시그널 판별에 절대 사용 금지!
              var rawString = JSON.stringify(item);
              hits.push({ id:id, name:name, addr:String(addrVal), imgCount:imgCount, hasReviewSignal:hasReviewSignal, hasVisitorReview:hasVisitorReview, rawString:rawString });
            }
          }
        }
        return hits.length >= 2 ? hits : null;
      }

      // ── 재귀 JSON 탐색 ──
      function findPlaceArray(obj, depth, parentKey) {
        if ((depth||0) > 25 || !obj) return null;
        var d = (depth||0) + 1;
        var pk = String(parentKey||'').toLowerCase();
        if (/\bad\b|aditem|powerlink|sponsor|banner|cm_a|nkw|plcash/i.test(pk)) return null;
        if (Array.isArray(obj) && obj.length >= 2) {
          var items = extractPlaceItems(obj);
          if (items) return items;
          for (var ai = 0; ai < Math.min(obj.length, 30); ai++) {
            var r = findPlaceArray(obj[ai], d, String(ai)); if (r) return r;
          }
        }
        if (typeof obj === 'object' && !Array.isArray(obj)) {
          var keys = Object.keys(obj);
          var tier1 = keys.filter(function(k) { return /place|smart_?around|organic|PlaceList|placeList/i.test(k); });
          var tier2 = keys.filter(function(k) { return !tier1.includes(k) && /list|items|result|data|search|local|query|queries/i.test(k); });
          var adKeys = keys.filter(function(k) { return /\bad\b|aditem|powerlink|sponsor|banner/i.test(k.toLowerCase()); });
          var rest = keys.filter(function(k) { return !tier1.includes(k) && !tier2.includes(k) && !adKeys.includes(k); });
          var ordered = tier1.concat(tier2).concat(rest);
          for (var ki = 0; ki < ordered.length; ki++) {
            var r = findPlaceArray(obj[ordered[ki]], d, ordered[ki]); if (r) return r;
          }
        }
        return null;
      }

      // ── NEXT_DATA 우선 탐색 ──
      function findSearchPlaceQuery(obj) {
        if (!obj) return null;
        try {
          var paths = [
            obj.props && obj.props.pageProps && obj.props.pageProps.dehydratedState,
            obj.props && obj.props.pageProps, obj.props, obj
          ];
          for (var pi = 0; pi < paths.length; pi++) {
            var target = paths[pi]; if (!target) continue;
            var queries = target.queries || target.dehydratedQueries || target.cache;
            if (!Array.isArray(queries)) continue;

            // ★ 1차: queryKey 정규식 (기존 호환) ★
            for (var qi = 0; qi < queries.length; qi++) {
              var q = queries[qi];
              var qKey = JSON.stringify(q.queryKey || q.key || '');
              if (/SearchPlaceList|PlaceList|place.*list|smart_?around|local.*search|nxPlaces/i.test(qKey)) {
                var data = (q.state && q.state.data) || q.data || q.result;
                if (data) return data;
              }
            }

            // ★ 2차: 전체 순회 — placeId/businessId 3개 이상 포함된 쿼리를 플레이스 리스트로 판정 ★
            for (var qi2 = 0; qi2 < queries.length; qi2++) {
              var q2 = queries[qi2];
              var qStr = JSON.stringify(q2);
              // 광고 쿼리 스킵
              if (/powerlink|adItem|AD_ITEM|sponsoredList/i.test(qStr)) continue;
              // placeId 또는 businessId가 3개 이상 포함되면 플레이스 리스트로 판정
              var idMatches = (qStr.match(/placeId|businessId/gi) || []).length;
              if (idMatches >= 3) {
                return (q2.state && q2.state.data) || q2.data || q2;
              }
            }
          }
        } catch(e) {}
        return null;
      }

      // ── APOLLO __ref 순서 보장 해석기 (Legacy용) ──
      function resolveApolloItems(apolloData) {
        if (!apolloData || typeof apolloData !== 'object') return null;
        var rootQuery = apolloData['ROOT_QUERY'] || apolloData['root_query'];
        if (!rootQuery || typeof rootQuery !== 'object') return null;
        var rqKeys = Object.keys(rootQuery);
        for (var i = 0; i < rqKeys.length; i++) {
          var k = rqKeys[i];
          if (!/PlaceList|placeSearch|searchPlace|localSearch|smartAround|nxPlaces|placeList|PlaceBlueLink/i.test(k)) continue;
          if (/\bad\b|adItem|powerlink|sponsor/i.test(k)) continue;
          var val = rootQuery[k];
          if (!val || typeof val !== 'object') continue;
          var candidates = [val.items, val.result, val.data, val.list, val.places, val.businesses, val.edges, val.nodes];
          if (Array.isArray(val)) candidates.unshift(val);
          for (var c = 0; c < candidates.length; c++) {
            var arr = candidates[c];
            if (!Array.isArray(arr) || arr.length < 2) continue;
            var hasRefs = arr[0] && (arr[0].__ref || (arr[0].node && arr[0].node.__ref));
            if (hasRefs) {
              var resolved = [];
              for (var j = 0; j < arr.length; j++) {
                var refKey = arr[j].__ref || (arr[j].node && arr[j].node.__ref);
                if (typeof refKey === 'string' && apolloData[refKey]) resolved.push(apolloData[refKey]);
                else if (typeof arr[j] === 'object' && !arr[j].__ref) resolved.push(arr[j]);
              }
              if (resolved.length >= 2) { var it = extractPlaceItems(resolved); if (it) return it; }
            } else {
              var it2 = extractPlaceItems(arr); if (it2) return it2;
            }
          }
        }
        return null;
      }

      // ── 순위 매칭 (분점 오진 방지: ID 최우선 + 주소 대조) ──
      function matchRank(items, pid, nb, biz, tAddr) {
        var limit = Math.min(items.length, 10);
        // 1순위: 업장 ID 완전 일치 (100% 확실)
        for (var i = 0; i < limit; i++) {
          if (items[i].id === pid) return { rank: i+1, method: 'id' };
        }
        // 2순위: rawString 안에 ID 존재
        for (var i = 0; i < limit; i++) {
          if (items[i].rawString && items[i].rawString.indexOf(pid) !== -1) return { rank: i+1, method: 'deep-id' };
        }
        // 3순위: 이름 매칭 + 분점 스나이퍼 필터
        if (nb.length >= 4) {
          for (var i = 0; i < limit; i++) {
            var rn = norm(items[i].name);
            if (rn.length >= 4 && rn.indexOf(nb) === 0) {
              // ★ 분점 필터: 이름에 분점 키워드가 있으면 무조건 스킵
              var branchKws = [
                '본점','직영','직영점','1호점','2호점','3호점','4호점','5호점',
                '강남','서초','잠실','송파','홍대','합정','연남','마포','신촌','이대','건대','성수','왕십리',
                '종로','광화문','을지로','명동','동대문','혜화','대학로','이태원','용산','한남','삼성','역삼',
                '선릉','논현','청담','압구정','신사','가로수길','여의도','영등포','당산','목동','양천',
                '노원','도봉','강북','미아','창동','상봉','중랑','면목','천호','길동','강동','고덕',
                '사당','방배','신림','봉천','관악','동작','흑석','구로','신도림','가산','금천','독산',
                '상암','수색','은평','서대문','연희','불광',
                '분당','판교','수지','광교','영통','수원','동탄','평택','일산','파주','김포',
                '인천','부평','송도','청라','검단','구월','하남','위례','미사','광명','안양','의왕',
                '성남','용인','화성','시흥','안산','군포',
                '서면','마린시티','시청','센텀','광안리','해운대','부산대','사상','하단','동래',
                '연산','남포','자갈치','중앙','전포','부전','양정','범일','범천','남천','경성대',
                '대연','용호','기장','정관','수영','광안','민락','다대포',
                '동성로','수성','범어','만촌','황금','시지','달서','성서','월성','두류','죽전',
                '둔산','유성','궁동','봉명','탄방','관저','노은','도안',
                '충장로','상무','수완','첨단','봉선','운암','금남로',
                '울산','창원','마산','진해','김해','양산','진주','포항','경주','구미',
                '전주','익산','군산','목포','여수','순천','춘천','원주','강릉','속초',
                '제주','서귀포','연동','노형','중문','애월',
              ];
              var fullName = items[i].name;
              var isBranch = false;
              for (var bk = 0; bk < branchKws.length; bk++) {
                if (fullName.indexOf(branchKws[bk]) !== -1) { isBranch = true; break; }
              }
              // 우리 업체 주소에 해당 지역이 있으면 분점 아님
              if (isBranch && tAddr) {
                for (var bk2 = 0; bk2 < branchKws.length; bk2++) {
                  if (fullName.indexOf(branchKws[bk2]) !== -1 && tAddr.indexOf(branchKws[bk2]) !== -1) { isBranch = false; break; }
                }
              }
              if (isBranch) continue;
              // 주소 구 대조
              if (tAddr && items[i].addr) {
                var tGu = (tAddr.match(/([가-힣]{2,4}구)/) || [])[1];
                if (tGu && items[i].addr.indexOf(tGu) === -1) continue;
              }
              return { rank: i+1, method: 'name-prefix' };
            }
          }
        }
        return { rank: null, method: 'none' };
      }

      // ══════════════════════════════════════════
      // ★★★ DOM에서 직접 파싱 (fetch 사용 안 함) ★★★
      // ══════════════════════════════════════════
      try {
        var html = document.documentElement.outerHTML || '';
        if (html.length < 500) {
          return { rank:null, method:'empty-html', total:0, topNames:[], mapSignals:{imgCount:0,hasReviewSignal:false,hasVisitorReview:false} };
        }

        var items = null;

        // ★ 1순위: __skt_view_payload__ (구지도 순서 보장) ★
        var scripts = document.querySelectorAll('script:not([src])');
        for (var si0 = 0; si0 < scripts.length; si0++) {
          var stxt = scripts[si0].textContent || '';
          if (stxt.indexOf('__skt_view_payload__') !== -1) {
            var sktRe = /window\.__skt_view_payload__\s*=/;
            var sktResults = safeExtractJSON(stxt, sktRe);
            for (var sr = 0; !items && sr < sktResults.length; sr++) {
              items = findPlaceArray(sktResults[sr], 0, 'skt-view');
            }
            if (items) break;
          }
        }

        // 2순위: __NEXT_DATA__
        if (!items) {
        var ndEl = document.getElementById('__NEXT_DATA__');
        if (ndEl) {
          try {
            var nd = JSON.parse(ndEl.textContent);
            var pq = findSearchPlaceQuery(nd);
            if (pq) items = findPlaceArray(pq, 0, 'placeQuery');
            if (!items) items = findPlaceArray(nd, 0, 'nextdata');
          } catch(e) {}
        }
        }

        // ★ 3순위: __APOLLO_STATE__ — __ref 배열 순서 보장 ★
        if (!items) {
          for (var si1 = 0; si1 < scripts.length; si1++) {
            var atxt = scripts[si1].textContent || '';
            if (atxt.indexOf('__APOLLO_STATE__') !== -1) {
              var aRe = /window\.__APOLLO_STATE__\s*=/gi;
              var aResults = safeExtractJSON(atxt, aRe);
              for (var ar = 0; !items && ar < aResults.length; ar++) {
                items = resolveApolloItems(aResults[ar]);
              }
              if (items) break;
            }
          }
        }

        // 4순위: 모든 인라인 script 전수 스캔 (APOLLO, skt_view, application/json 등)
        if (!items) {
          var scripts = document.querySelectorAll('script:not([src])');
          for (var si = 0; si < scripts.length; si++) {
            var txt = scripts[si].textContent || '';
            if (txt.length < 150) continue;
            if (!/placeId|businessId|"sid"|place_id|placeList|place_nid|PlaceItem|SearchPlace|localSearch|smartAround|naver\.com\/place|"rank"|"imageCount"|reviewCount/i.test(txt)) continue;

            // 방법1: 전체 JSON
            try { var data = JSON.parse(txt); var pq = findSearchPlaceQuery(data); if (pq) items = findPlaceArray(pq, 0, 'script-query'); if (!items) items = findPlaceArray(data, 0, 'script'); if (items) break; } catch(e) {}

            // 방법2: window.__XXXX__ = {...} ★균형 괄호 추출★
            if (!items) {
              var winRe = /window\.__([A-Za-z0-9_]+)__\s*=/gi;
              var winResults = safeExtractJSON(txt, winRe);
              for (var wi = 0; !items && wi < winResults.length; wi++) {
                var wpq = findSearchPlaceQuery(winResults[wi]);
                if (wpq) items = findPlaceArray(wpq, 0, 'win-balanced');
                if (!items) items = findPlaceArray(winResults[wi], 0, 'win-balanced');
              }
            }

            // 방법3: var/const/let xxx = {...} ★균형 괄호 추출★
            if (!items) {
              var varAssignRe = /(?:var|let|const)\s+[A-Za-z_]\w*\s*=/gi;
              var varResults = safeExtractJSON(txt, varAssignRe);
              for (var vi = 0; !items && vi < varResults.length; vi++) {
                items = findPlaceArray(varResults[vi], 0, 'var-balanced');
              }
            }

            // 방법4: 일반 할당 xxx = {...} ★균형 괄호 추출★
            if (!items) {
              var assignRe = /[A-Za-z_]\w*\s*=\s*(?=[\{\[])/gi;
              var assignResults = safeExtractJSON(txt, assignRe);
              for (var ai2 = 0; !items && ai2 < assignResults.length; ai2++) {
                items = findPlaceArray(assignResults[ai2], 0, 'assign-balanced');
              }
            }

            if (items) break;
          }
        }

        // ★ HTML 섹션 격리 — 광고 영역 제거 후 유기적 플레이스만 남김 ★
        var organicHtml = html;
        organicHtml = organicHtml.replace(/<(?:div|section|ul)[^>]*class="[^"]*(?:ad_area|power_link|spns|sponsor|_ad_|plc_adpk|sc_ad)[^"]*"[^>]*>[\s\S]*?<\/(?:div|section|ul)>/gi, '');
        organicHtml = organicHtml.replace(/<[^>]*(?:searchad\.naver|adcr\.naver|ad\.search\.naver)[^>]*>[\s\S]{0,500}?<\/[^>]+>/gi, '');

        // 전략3: DOM 카드 직접 스캔 ★우선순위 상승★ (Puppeteer에서 가장 정확)
        if (!items) {
          var cardSels = [
            'li[class*="PlaceItem"]', 'li[class*="place_item"]', 'li[class*="item_"]',
            'div[class*="PlaceItem"]', 'div[class*="place_item"]',
            '[class*="place_section"] li', '[data-type="place"] li'
          ];
          var cards = [];
          for (var cs = 0; cs < cardSels.length; cs++) {
            cards = document.querySelectorAll(cardSels[cs]);
            if (cards.length >= 2) break;
          }
          if (cards.length >= 2) {
            var domItems = [];
            for (var ci = 0; ci < Math.min(cards.length, 15); ci++) {
              var card = cards[ci];
              // ★ 광고 카드 엄격 제외 ★
              var cardTxt = (card.innerText || '').trim();
              if (/^광고|파워링크|powerlink|sponsor/i.test(cardTxt)) continue;
              var adBadge = card.querySelector('span[class*="ad"], [class*="badge_ad"], [class*="sponsored"], [class*="ad_badge"]');
              if (adBadge && /광고|ad|sponsor/i.test(adBadge.textContent||'')) continue;
              // href 링크에 searchad/adcr 포함 시 제외
              var adLink = card.querySelector('a[href*="searchad.naver"], a[href*="adcr.naver"], a[href*="ad.search.naver"]');
              if (adLink) continue;
              // href에서 업체 ID 추출
              var links = card.querySelectorAll('a[href]');
              var cardId = '';
              for (var lk = 0; lk < links.length; lk++) {
                var href = links[lk].getAttribute('href') || '';
                var idM = href.match(/(?:place|restaurant|hairshop|hospital|accommodation)\/(\d{5,15})/);
                if (idM) { cardId = idM[1]; break; }
              }
              if (!cardId) continue;
              // 이름 추출
              var nameEl = card.querySelector('[class*="place_bluelink"], [class*="YwYLL"], [class*="TYaxT"], a[class*="name"], [class*="title"]');
              var cardName = nameEl ? (nameEl.textContent||'').trim() : '';
              if (!cardName) {
                var firstA = card.querySelector('a');
                cardName = firstA ? (firstA.textContent||'').trim().slice(0,40) : '';
              }
              // ★ 카드 내부에서 직접 시그널 추출 (img 태그 + 썸네일 컨테이너) ★
              var cardImgs = card.querySelectorAll('img');
              var cardImgCount = cardImgs.length;
              // 리소스 차단으로 img 태그가 없어도 썸네일 컨테이너 껍데기는 남아있음
              if (cardImgCount < 2) {
                var thumbContainers = card.querySelectorAll('[class*="image"], [class*="thumb"], [class*="photo"], [class*="img_area"], [class*="thmb"], [class*="visual"], [class*="pic"]');
                if (thumbContainers.length >= 2) cardImgCount = thumbContainers.length;
                else if (thumbContainers.length >= 1 && cardImgCount === 0) cardImgCount = 1;
              }
              var cardReview = /방문자리뷰|블로그리뷰|별점|이런\s*점이\s*좋아요|영수증리뷰/i.test(cardTxt);
              domItems.push({ id:cardId, name:cardName, addr:'', imgCount:cardImgCount, hasReviewSignal:cardReview, hasVisitorReview:cardReview, rawString:'' });
            }
            if (domItems.length >= 2) items = domItems;
          }
        }

        // 전략4: 유기적 HTML에서 place/ID 링크 (광고 격리)
        if (!items) {
          var linkRe = /(?:place\.naver\.com|map\.naver\.com)\/(?:place|restaurant|hairshop|hospital|accommodation|p\/entry\/place)\/(\d{5,15})/g;
          var seen = {}, linkItems = [], lm;
          while ((lm = linkRe.exec(organicHtml)) !== null) {
            if (!seen[lm[1]]) {
              var pos = lm.index;
              var ctx = organicHtml.slice(Math.max(0, pos - 300), Math.min(organicHtml.length, pos + 300));
              if (/광고|파워링크|powerlink|searchad|adcr|sponsor/i.test(ctx)) continue;
              seen[lm[1]] = true;
              linkItems.push({ id:lm[1], name:'', addr:'', imgCount:0, hasReviewSignal:false, hasVisitorReview:false, rawString:'' });
            }
          }
          if (linkItems.length >= 2) {
            var _pp = '(?:place|restaurant|hairshop|hospital|accommodation)/';
            for (var li = 0; li < linkItems.length; li++) {
              var pid2 = linkItems[li].id;
              var nameRe = new RegExp(_pp + pid2 + '[\\s\\S]{0,500}?class="[^"]*(?:place_bluelink|YwYLL|TYaxT|title)[^"]*"[^>]*>([^<]{2,40})<','i');
              var nm = organicHtml.match(nameRe);
              if (nm) { linkItems[li].name = nm[1].trim(); continue; }
              var ariaRe = new RegExp(_pp + pid2 + '[\\s\\S]{0,300}?aria-label="([^"]{2,40})"','i');
              var am = organicHtml.match(ariaRe);
              if (am) { linkItems[li].name = am[1].trim(); }
            }
            if (linkItems.length >= 2) items = linkItems;
          }
        }

        // 전략5: 유기적 HTML에서 ID+이름 쌍 (광고 컨텍스트 제외)
        if (!items) {
          var pairRe = /["'](?:id|placeId|businessId|nid|sid)["']\s*:\s*["']?(\d{5,15})["']?[\s\S]{0,400}?["'](?:name|title|businessName|placeName)["']\s*:\s*["']([^"']{2,40})["']/g;
          var pairs = [], pairSeen = {}, pm;
          while ((pm = pairRe.exec(organicHtml)) !== null) {
            var pos2 = pm.index;
            var ctx2 = organicHtml.slice(Math.max(0, pos2 - 200), Math.min(organicHtml.length, pos2 + 200));
            if (/광고|파워링크|"isAd"\s*:\s*true|"adyn"\s*:\s*"Y"|"adId"/i.test(ctx2)) continue;
            if (!pairSeen[pm[1]]) {
              pairSeen[pm[1]] = true;
              pairs.push({ id:pm[1], name:pm[2].trim(), addr:'', imgCount:0, hasReviewSignal:false, hasVisitorReview:false, rawString:'' });
            }
          }
          if (pairs.length >= 2) items = pairs;
        }

        // (전략6 삭제 — 전체 HTML 무차별 스캔은 광고 오진 원인이므로 제거)

        if (!items || items.length < 1) {
          return { rank:null, method:'no-items', total:0, topNames:[], mapSignals:{imgCount:0,hasReviewSignal:false,hasVisitorReview:false} };
        }

        // ★ 광고 아이템 최종 필터링 (전략3,4에서 추가된 아이템 포함) ★
        items = items.filter(function(it) { return !isAdItem(it); });

        var m = matchRank(items, targetPid, targetNb, targetBizName, targetAddr);

        // ══════════════════════════════════════════════════════════════
        // ★★★ 신/구지도 판별: 핀셋 스캔 (Pinpoint Detection) ★★★
        //
        // 1순위: API/JSON items[rank-1]의 imgCount, hasReviewSignal, hasVisitorReview
        // 2순위: DOM에서 내 업체 카드 1개만 핀셋으로 집어서 사진/리뷰 확인
        // 둘 다 증거 없으면 → 구지도(old)
        // ══════════════════════════════════════════════════════════════
        var mapSignals = { imgCount:0, hasReviewSignal:false, hasVisitorReview:false, source:'none' };

        if (m.rank) {
          // ★ 1순위: API/JSON 객체 데이터 (가장 정확) ★
          var myItem = items[m.rank - 1];
          if (myItem) {
            if (myItem.imgCount >= 1) {
              mapSignals.imgCount = myItem.imgCount;
              mapSignals.source = 'json-img';
            }
            if (myItem.hasReviewSignal) {
              mapSignals.hasReviewSignal = true;
              if (mapSignals.source === 'none') mapSignals.source = 'json-review';
            }
            if (myItem.hasVisitorReview) {
              mapSignals.hasVisitorReview = true;
              if (mapSignals.source === 'none') mapSignals.source = 'json-visitor';
            }
            // ★ rawString 폴백 ★
            if (mapSignals.source === 'none' && myItem.rawString) {
              var rs = myItem.rawString;
              if (/"imageCount"[:\s]*[1-9]|"imgCount"[:\s]*[1-9]|"thumUrl"|"imageUrl"|"thumbnail"/.test(rs)) {
                mapSignals.imgCount = 2; mapSignals.source = 'raw-img';
              }
              if (/"menuInfo"|"reviewKeywordList"|"receiptReview"|"scoreInfo"|"microReview"/.test(rs)) {
                mapSignals.hasReviewSignal = true; if (mapSignals.source === 'none') mapSignals.source = 'raw-review';
              }
              if (/"reviewCount"[:\s]*"?[1-9]|"visitorReviewCount"[:\s]*"?[1-9]/.test(rs)) {
                mapSignals.hasVisitorReview = true; if (mapSignals.source === 'none') mapSignals.source = 'raw-visitor';
              }
            }
          }

          // ★ 2순위: DOM 핀셋 스캔 (API에서 증거 못 찾은 경우만) ★
          if (mapSignals.source === 'none') {
            try {
              var myCard = null;
              var pidLinks = document.querySelectorAll('a[href*="' + targetPid + '"]');
              if (pidLinks.length > 0) {
                myCard = pidLinks[0].closest('li, [class*="item"], [class*="PlaceItem"], [class*="place_item"]');
                if (!myCard) myCard = pidLinks[0].parentElement && pidLinks[0].parentElement.parentElement;
              }
              if (myCard) {
                // 내 카드 안의 img + 썸네일 컨테이너 카운트
                var cardImgs = myCard.querySelectorAll('img');
                var imgCnt = cardImgs.length;
                // 리소스 차단으로 img 안 붙어도 컨테이너는 남아있음
                if (imgCnt < 2) {
                  var thumbs = myCard.querySelectorAll('[class*="image"], [class*="thumb"], [class*="photo"], [class*="img_area"], [class*="thmb"], [class*="visual"], [class*="pic"]');
                  if (thumbs.length >= 2) imgCnt = thumbs.length;
                  else if (thumbs.length >= 1 && imgCnt === 0) imgCnt = 1;
                }
                if (imgCnt >= 2) {
                  mapSignals.imgCount = imgCnt;
                  mapSignals.source = 'dom-card-img';
                }
                // 내 카드 안의 텍스트만 검사
                if (mapSignals.source === 'none') {
                  var cardText = myCard.innerText || myCard.textContent || '';
                  if (/별점|방문자리뷰|블로그리뷰|이런\s*점이\s*좋아요|영수증리뷰/i.test(cardText)) {
                    mapSignals.hasVisitorReview = true;
                    mapSignals.source = 'dom-card-text';
                  }
                }
                // 썸네일 컨테이너만 있어도 신지도 증거
                if (mapSignals.source === 'none' && imgCnt >= 1) {
                  mapSignals.imgCount = imgCnt;
                  mapSignals.hasReviewSignal = true;
                  mapSignals.source = 'dom-thumb-container';
                }
              }
            } catch(detectErr) { /* 핀셋 스캔 실패 시 구지도 유지 */ }
          }
        }

        return {
          rank: m.rank, method: m.method, total: items.length, mapSignals: mapSignals,
          topNames: items.slice(0, 5).map(function(x, i) { return (i+1) + '.' + x.name + '(' + x.id.slice(-4) + ')'; })
        };
      } catch(err) {
        return { rank:null, method:'eval-err', total:0, topNames:[], mapSignals:{imgCount:0,hasReviewSignal:false,hasVisitorReview:false}, error:String(err) };
      }

    }, pid, nb, bizName, addr).catch(e => ({
      rank:null, method:'page-err', total:0, topNames:[], mapSignals:{imgCount:0,hasReviewSignal:false,hasVisitorReview:false}, error:e.message
    }));

    const sig = result.mapSignals || {};
    console.log(`  [${result.method}] rank=${result.rank??'null'} total=${result.total} img=${sig.imgCount} review=${sig.hasReviewSignal} visitor=${sig.hasVisitorReview} src=${sig.source||'none'} ${(result.topNames||[]).slice(0,3).join(' | ')}`);

    if (!result.rank || result.rank > 5) {
      return { rank: null, mapType: null, loadFail: result.total === 0 };
    }

    // ★★★ 신/구지도 판별 — v6: HTML 텍스트 정규식 즉시 판별 (0ms) ★★★
    let legacyHtml = '';
    try { legacyHtml = await page.content(); } catch(e) {}
    const hasFilterTag = /<[^>]+class="[^"]*(?:place_filter|sc_filter|loc_filter|filter_wrap|filter_area|btn_filter|filter_item)[^"]*"[^>]*>/i.test(legacyHtml);
    const hasSaveBtnTag = /<[^>]+class="[^"]*(?:btn_save|save_btn|place_save)[^"]*"[^>]*>/i.test(legacyHtml);
    const mapType = (hasFilterTag || hasSaveBtnTag) ? 'new' : 'old';

    console.log(`    [mapType] ${mapType}`);
    return { rank: result.rank, mapType, loadFail: false };

  } catch(e) {
    console.error('  checkRank err:', e.message?.slice(0, 80));
    return { rank: null, mapType: null, loadFail: true };
  } finally {
    // ★ 리소스 차단 해제 (다음 사용을 위해) ★
    try {
      page.removeAllListeners('request');
      await page.setRequestInterception(false);
    } catch(cleanErr) {}
    returnPage(page);
  }
}

// ★ checkRankDual — 통합 단일 함수 (Fast가 fetch+JSON파싱+0ms mapType 처리) ★
async function checkRankDual(keyword, bizName, placeId, mTypes, bizAddress) {
  // ★ 예방적 세션 세탁 ★
  sessionRequestCount++;
  if (sessionRequestCount >= SESSION_LIMIT) {
    await resetBrowser(`${SESSION_LIMIT}회 주기적 세션 세탁`);
  }

  // ★ 연속 실패 임계치 도달 시 먼저 브라우저 리셋 ★
  if (consecutiveFailCount >= FAIL_THRESHOLD) {
    await resetBrowser(`연속 ${consecutiveFailCount}회 실패 — 안티봇 차단 추정`);
    consecutiveFailCount = 0;
  }

  // ★ 통합 checkRank — fetch + JSON 파싱 + 0ms mapType (1회 요청으로 완결) ★
  let r = await checkRankFast(keyword, bizName, placeId, bizAddress);

  // ★ 캡챠 감지 시: 즉시 리셋 후 1회 재시도 ★
  if (r.method === 'fast-captcha') {
    await resetBrowser('캡챠 감지');
    r = await checkRankFast(keyword, bizName, placeId, bizAddress);
    if (r.method === 'fast-captcha') {
      return { hits: [], loadFail: true };
    }
  }

  // ★ 네비게이션 에러 시 1회 재시도 ★
  if (r.loadFail && r.method !== 'fast-captcha') {
    await new Promise(r => setTimeout(r, 500));
    r = await checkRankFast(keyword, bizName, placeId, bizAddress);
  }

  // ★★★ Legacy 폴백 — 진짜 차단/에러만 재시도 (no-items는 정상 빈 결과 → 스킵) ★★★
  // fast-no-items/no-place-section: HTML 정상 수신 + 플레이스 영역 없음 = 해당없는 키워드 → 즉시 넘어감
  // fast-empty/fast-err: 진짜 차단 또는 크래시 → Legacy로 재확인
  const fastFailMethods = ['fast-empty', 'fast-err'];
  if (!r.rank && fastFailMethods.includes(r.method)) {
    const legacyR = await checkRankLegacy(keyword, bizName, placeId, bizAddress);
    if (legacyR.rank) {
      r = { rank: legacyR.rank, mapType: legacyR.mapType, loadFail: false, method: 'legacy-fallback' };
    } else if (legacyR.loadFail) {
      r.loadFail = true; // Legacy도 실패 → loadFail 전파
    }
  }

  // ★ 연속 실패 카운터 — loadFail:true는 오직 nav-err/captcha/err만 해당 ★
  if (r.loadFail) {
    consecutiveFailCount++;
    if (consecutiveFailCount % 5 === 0) {
      console.log(`  [fail:${consecutiveFailCount}] "${keyword}" method=${r.method}`);
    }
  } else {
    consecutiveFailCount = 0; // ★ 정상 응답이면 즉시 초기화 ★
  }

  const hits = [];
  if (r.rank && r.rank <= 5) {
    hits.push(r);
  }
  return { hits, loadFail: r.loadFail };
}
// ── 자동저장 Checkpoint ──
// ── 스마트 날짜 네이밍 ──
function _smartDate() {
  const d = new Date();
  return String(d.getMonth()+1).padStart(2,'0') + '.' + String(d.getDate()).padStart(2,'0');
}
function _smartName(bizName, placeId) {
  return (bizName || placeId || 'unknown').slice(0,20).replace(/[\\/?*\[\]:]/g,'');
}

// ── 엑셀 자동저장 (10개마다, autosaves 폴더) ──
const _autosaveDir = path.join(__dirname, 'autosaves');
if (!fs.existsSync(_autosaveDir)) try { fs.mkdirSync(_autosaveDir, {recursive:true}); } catch(e){}

function _autoSaveXlsx(placeId, bizName, top5, checked, round, streamConsumed, urls) {
  try {
    const wb = XLSX.utils.book_new();
    // ★ A=발견순서, B=신지도키워드, C=순위, D=발견순서, E=구지도키워드, F=순위 ★
    const newArr = top5.filter(k => k.mapType === 'new');
    const oldArr = top5.filter(k => k.mapType === 'old');
    const maxLen = Math.max(newArr.length, oldArr.length, 1);
    const rows = [['발견순서', '신지도 키워드', '순위', '발견순서', '구지도 키워드', '순위']];
    for (let i = 0; i < maxLen; i++) {
      rows.push([
        newArr[i]?.foundOrder||'', newArr[i]?.keyword||'', newArr[i]?.rank||'',
        oldArr[i]?.foundOrder||'', oldArr[i]?.keyword||'', oldArr[i]?.rank||''
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{wch:8},{wch:30},{wch:6},{wch:8},{wch:30},{wch:6}];
    XLSX.utils.book_append_sheet(wb, ws, _smartName(bizName, placeId).slice(0,28) || '키워드');
    // SessionData (메타 정보만 — keywordsJSON 제거: 32767자 셀 한계 방지)
    const sd = [
      ['key','value'],
      ['placeId', placeId],
      ['bizName', bizName || ''],
      ['checked', checked],
      ['timestamp', new Date().toISOString()],
      ['totalNew', String(top5.filter(k=>k.mapType==='new').length)],
      ['totalOld', String(top5.filter(k=>k.mapType==='old').length)],
      ['total', String(top5.length)]
    ];
    const sws = XLSX.utils.aoa_to_sheet(sd);
    sws['!cols'] = [{wch:20},{wch:100}];
    XLSX.utils.book_append_sheet(wb, sws, 'SessionData');
    const fn = `${_smartDate()}_${_smartName(bizName, placeId)}_자동저장.xlsx`;
    const fp = path.join(_autosaveDir, fn);
    XLSX.writeFile(wb, fp, {bookType:'xlsx'});
    console.log(`  💾 자동저장: 🔵${newArr.length}+🟢${oldArr.length}=${top5.length}개 → ${fn}`);
    return fp;
  } catch(e) { console.error('자동저장 오류:', e.message); return null; }
}

// ── 누적 히스토리 (중복 제외용) ──
const _histDir = path.join(__dirname, 'history');
if (!fs.existsSync(_histDir)) try { fs.mkdirSync(_histDir, {recursive:true}); } catch(e){}

function _histPath(placeId) { return path.join(_histDir, placeId + '.json'); }
function _histLoad(placeId) {
  try { const fp = _histPath(placeId); if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp,'utf-8')); } catch(e){}
  return [];
}
function _histSave(placeId, arr) {
  try { fs.writeFileSync(_histPath(placeId), JSON.stringify(arr), 'utf-8'); } catch(e){}
}
function _histAppend(placeId, newKeywords) {
  const prev = _histLoad(placeId);
  const set = new Set(prev);
  newKeywords.forEach(kw => set.add(kw));
  _histSave(placeId, [...set]);
  return set.size;
}
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// ██  /api/suggest-words — 4그룹 추천 단어 자동 채움  ██
// ══════════════════════════════════════════════════════════
app.post('/api/suggest-words', async (req, res) => {
  const { placeUrl } = req.body;
  if (!placeUrl) return res.status(400).json({error:'URL 필요'});
  const idM = placeUrl.match(/(\d{7,15})/);
  if (!idM) return res.status(400).json({error:'플레이스 ID를 찾을 수 없습니다'});
  try {
    const info = await deepCrawl(idM[1]);
    const addr = info.address || '';

    // ── Fisher-Yates 셔플 ──
    function shuffle(arr) {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    // ══════════════════════════════════════════
    // 그룹1: 지역/위치/명소 — 고품질 랜덤화
    // ══════════════════════════════════════════
    const g1pool = new Set();
    const metroM = addr.match(/(서울|부산|대구|인천|광주|대전|울산|세종|수원|창원|고양|용인|성남|안양|안산|청주|전주|천안)/);
    const cityM = addr.match(/([가-힣]{2,6}(?:시|군))/);
    const guM = addr.match(/([가-힣]{2,4}구)/);
    const dongM = addr.match(/([가-힣]{2,4}동)/);
    const roM = addr.match(/([가-힣]{2,8}(?:로|길))/);
    if (metroM) { g1pool.add(metroM[1]); g1pool.add(metroM[1]+'시'); }
    if (cityM) { g1pool.add(cityM[1]); const b=cityM[1].replace(/시$|군$/,''); if(b.length>=2) g1pool.add(b); }
    if (guM) { g1pool.add(guM[1]); const b=guM[1].replace(/구$/,''); if(b.length>=2) g1pool.add(b); }
    if (dongM) { g1pool.add(dongM[1]); const b=dongM[1].replace(/동$/,''); if(b.length>=2) g1pool.add(b); }
    if (roM) g1pool.add(roM[1]);
    // LANDMARK_DB 매칭 — 역, 명소, 쇼핑 등 최대한 풀에 담기
    for (const r of Object.keys(LANDMARK_DB)) {
      if (addr.includes(r) || (info.name||'').includes(r)) {
        g1pool.add(r);
        const db = LANDMARK_DB[r]; if (!db) continue;
        (db.station||[]).forEach(s => g1pool.add(s));
        (db.sights||[]).forEach(s => g1pool.add(s));
        (db.shopping||[]).forEach(s => g1pool.add(s));
        (db.univ||[]).forEach(s => g1pool.add(s));
        (db.gov||[]).forEach(s => g1pool.add(s));
      }
    }
    // 셔플 후 상위 15~20개
    const g1arr = shuffle([...g1pool].filter(Boolean)).slice(0, 20);

    // ══════════════════════════════════════════
    // 그룹2: 근접어/수식어 — 필수 5개 고정 + 랜덤 수식어
    // ══════════════════════════════════════════
    const g2fixed = ['주변', '근처', '인근', '부근', '앞'];
    const g2modPool = new Set([
      '현지인','로컬','숨은','유명한','가볼만한','분위기좋은','가성비','인기','핫플',
      '오래된','전통','신상','인생','줄서는','뷰좋은','깔끔한','친절한','조용한',
      '넓은','예쁜','추천하는','단골','후기좋은','갈만한','괜찮은','소문난','입소문'
    ]);
    // reviewTags 중 검색 가치 있는 태그만 필터링
    // ① 실용 태그 (검색에 유용한 서비스/시설 정보) — 즉시 채택
    const UTILITY_TAGS = new Set([
      '주차가능','무료주차','발렛파킹','주차장','넓은주차장',
      '단체가능','대형단체','단체석','룸','룸있는','개인룸','프라이빗룸',
      '예약가능','예약필수','웨이팅','당일예약',
      '배달가능','포장가능','테이크아웃','픽업','배달','포장',
      '반려동물','애견동반','펫프렌들리','테라스','루프탑','야외석',
      '아이동반','키즈존','유아의자','놀이방','수유실',
      '무선인터넷','와이파이','WiFi','콘센트','노트북','작업하기좋은',
      '장애인편의','엘리베이터','금연','흡연실','흡연가능',
      '24시간','24시','새벽영업','야간영업','심야영업','늦게까지',
      '주말영업','공휴일영업','연중무휴','당일시술',
      '남녀분리','개별샤워','탈의실','수건제공',
    ]);
    (info.reviewTags||[]).forEach(t => {
      const clean = t.trim().replace(/\s+/g, '');
      // ①-A: 실용 태그 매칭 (길이 무관)
      if (UTILITY_TAGS.has(clean)) {
        g2modPool.add(clean);
        return;
      }
      // ②: 2~8자 한글(+숫자) 태그, 문장형 제외
      if (clean.length >= 2 && clean.length <= 8
        && /^[가-힣0-9]+$/.test(clean)
        && !/있|없|했|좋았|같아|느낌|입니다|합니다|습니다|에요|해요/.test(clean)) {
        g2modPool.add(clean);
      }
    });
    const g2rand = shuffle([...g2modPool].filter(Boolean)).slice(0, 13);
    const g2arr = [...g2fixed, ...g2rand];

    // ══════════════════════════════════════════
    // 그룹3: 메뉴/서비스 — 100% 실제 데이터 고정 (셔플 금지)
    // ══════════════════════════════════════════
    // SERVICE_HINT, cfg.alone 절대 사용 안 함 — 가짜 메뉴 혼입 방지
    let g3arr = (info.menus||[]).filter(Boolean);
    // 비었으면 카테고리명으로 최소 폴백
    if (g3arr.length === 0) {
      if (info.category) g3arr.push(info.category);
      const cfg = CAT_CONFIG[info.catCode] || DEFAULT_CONFIG;
      if (cfg.label) g3arr.push(cfg.label);
    }

    // ══════════════════════════════════════════
    // 그룹4: 의도/접미어 — 고확률 검색어 랜덤화
    // ══════════════════════════════════════════
    const g4pool = [
      '맛집','추천','맛있는곳','잘하는곳','핫플','가는길','위치','예약',
      '영업시간','주차','메뉴','가격','전화번호','후기','리뷰','평점',
      '음식점','식당','점심','저녁','맛있는집','유명맛집','인기맛집',
      '가성비','혼밥','데이트','모임','회식','단체','가족','브런치',
      '야식','아침','주말','기념일','소개팅','2인','4인'
    ];
    // 업종별 의도어도 풀에 추가
    const cfg = CAT_CONFIG[info.catCode] || DEFAULT_CONFIG;
    (cfg.intents||[]).forEach(i => { if(!g4pool.includes(i)) g4pool.push(i); });
    (cfg.suffix||[]).forEach(s => { if(!g4pool.includes(s)) g4pool.push(s); });
    const g4arr = shuffle(g4pool).slice(0, 15);

    res.json({
      info: { name:info.name, category:info.category, catCode:info.catCode, address:info.address },
      group1: g1arr,
      group2: g2arr,
      group3: g3arr,
      group4: g4arr,
    });
  } catch(e) {
    console.error('suggest-words err:', e);
    res.status(500).json({error:e.message});
  }
});

// /api/deep-crawl — suggest-words와 동일 로직
app.post('/api/deep-crawl', (req, res) => {
  req.url = '/api/suggest-words';
  req.app._router.handle(req, res, () => res.status(500).json({error:'라우팅 실패'}));
});

// ══════════════════════════════════════════════════════════
// ██  사용자 조합 키워드 기반 분석 (Adlog 스타일)  ██
// ══════════════════════════════════════════════════════════
async function analyzeWithKeywords(placeUrl, keywordList, preferMap, targetCount, send, existingTop5=[]) {
  const idM = placeUrl.match(/(\d{7,15})/);
  if (!idM) { send({phase:'error',msg:'URL에서 플레이스 ID를 찾을 수 없습니다'}); return null; }
  const placeId = idM[1];
  let totalKws = keywordList.length;
  const mTypes = ['new','old'];
  const isResume = existingTop5.length > 0;
  console.log(`\n════ 조합 추출 ${isResume?'이어하기':'시작'} placeId:${placeId} | ${totalKws}개 키워드 | 기존결과:${existingTop5.length}개 | 우선:${preferMap} 목표:${targetCount||'∞'} ════`);

  send({phase:'crawling', placeId});
  const info = await deepCrawl(placeId);
  send({phase:'crawled', info, placeId});

  if (ctrl.stop) return {info, top5:existingTop5, checked:0, stopped:true, remaining:keywordList};

  send({phase:'generated', total:totalKws, catCode:info.catCode,
    catLabel:(CAT_CONFIG[info.catCode]||DEFAULT_CONFIG).label, placeId});

  const CONC = 5; // ★ 5개가 캡챠 없이 안정적 검증됨 ★
  // ★ 이어하기: 기존 결과로 초기화 ★
  const top5 = isResume ? [...existingTop5] : [];
  let checked = 0;
  let _lastAutoSave = 0;
  const _alreadyFound = new Set();
  // ★ 기존 결과의 키워드를 중복 방지 셋에 등록 ★
  if (isResume) {
    existingTop5.forEach(r => _alreadyFound.add(r.keyword));
    console.log(`  ♻️ 이어하기: 기존 ${existingTop5.length}개 결과 복원, 중복 방지 등록 완료`);
  }
  let lastProcessedIdx = 0;

  // ★ 지역명 필터: 전국구 키워드 사전 제거 (GPS 없는 서버에서 필수) ★
  const bizNameForFilter = info.name || '';
  const originalLen = keywordList.length;
  const filteredList = keywordList.filter(kw => hasLocationContext(kw, bizNameForFilter));
  const skippedKws = keywordList.filter(kw => !hasLocationContext(kw, bizNameForFilter));
  const skippedCount = originalLen - filteredList.length;
  if (skippedCount > 0) {
    console.log(`  ⚡ 지역명 필터: ${originalLen}개 → ${filteredList.length}개 (${skippedCount}개 전국구 스킵)`);
    keywordList = filteredList;
    totalKws = keywordList.length;
    // ★ 프론트에 스킵된 키워드 알림 → remaining에서 제거용 ★
    send({phase:'filtered', skippedKeywords: skippedKws, filteredCount: filteredList.length});
  }

  function isTargetReached() {
    if (targetCount <= 0) return false;
    const prefHits = top5.filter(x => x.mapType === preferMap).length;
    return prefHits >= targetCount;
  }

  function processResult(kw, dualResult) {
    const { hits, loadFail } = dualResult;
    checked++;
    let bestRank = null, bestMapType = null;
    for (const h of hits) {
      if (h.rank && h.rank <= 5) {
        if (!top5.some(x => x.keyword === kw && x.mapType === h.mapType)) {
          top5.push({keyword:kw, rank:h.rank, mapType:h.mapType, foundOrder: top5.length + 1});
        }
        if (!bestRank || h.rank < bestRank) { bestRank = h.rank; bestMapType = h.mapType; }
      }
    }
    _alreadyFound.add(kw);
    if (top5.length > 0 && top5.length % 10 === 0 && top5.length !== _lastAutoSave) {
      _lastAutoSave = top5.length;
      _autoSaveXlsx(placeId, info.name, top5, checked, 0, 0, [placeUrl]);
    }
    const nH = top5.filter(x=>x.mapType==='new').length;
    const oH = top5.filter(x=>x.mapType==='old').length;
    send({phase:'progress', checked, keyword:kw,
      rank: bestRank, mapType: bestMapType,
      top5Count: top5.length, paused: ctrl.pause,
      newHits: nH, oldHits: oH,
      targetReached: isTargetReached(),
      totalKeywords: totalKws,
      remainingCount: Math.max(0, totalKws - checked),
      placeId, bizName: info.name,
    });
    return loadFail;
  }

  const retries = [];
  for (let i = 0; i < keywordList.length; i += CONC) {
    if (ctrl.stop || ctrl.skip || isTargetReached()) break;
    lastProcessedIdx = i + CONC;
    await waitPause();
    const chunk = keywordList.slice(i, i + CONC).filter(kw => !_alreadyFound.has(kw));
    if (!chunk.length) continue;

    const results = await Promise.all(chunk.map(kw => checkRankDual(kw, info.name, placeId, mTypes, info.address)));
    for (let j = 0; j < chunk.length; j++) {
      if (ctrl.stop || ctrl.skip || isTargetReached()) break;
      if (processResult(chunk[j], results[j])) retries.push(chunk[j]);
    }
    if (i + CONC < keywordList.length && !ctrl.stop) await new Promise(r => setTimeout(r, 30));
  }

  if (retries.length > 0 && !ctrl.stop && !ctrl.skip && !isTargetReached()) {
    console.log(`  🔄 재시도 ${retries.length}개`);
    await new Promise(r => setTimeout(r, 1500));
    for (const kw of retries) {
      if (ctrl.stop || ctrl.skip || isTargetReached()) break;
      processResult(kw, await checkRankDual(kw, info.name, placeId, mTypes, info.address));
      await new Promise(r => setTimeout(r, 500));
    }
  }

  top5.sort((a,b) => a.rank - b.rank || (a.mapType==='new'?-1:1));
  _autoSaveXlsx(placeId, info.name, top5, checked, 0, 0, [placeUrl]);
  const remaining = keywordList.slice(lastProcessedIdx).filter(kw => !_alreadyFound.has(kw));
  const nH = top5.filter(x=>x.mapType==='new').length;
  const oH = top5.filter(x=>x.mapType==='old').length;
  console.log(`\n════ 완료: 🔵${nH} 🟢${oH} 총${top5.length}/${checked}검색 | 남은 대기열:${remaining.length} ════`);
  return {info, top5, checked, stopped:ctrl.stop, skipped:ctrl.skip, remaining};
}

app.post('/api/control', (req,res) => {
  const {action}=req.body;
  if(action==='pause') ctrl.pause=true;
  if(action==='resume') ctrl.pause=false;
  if(action==='stop') {ctrl.stop=true;ctrl.pause=false;}
  if(action==='skip') {ctrl.skip=true;ctrl.pause=false;}
  res.json({ok:true,...ctrl});
});

app.post('/api/analyze', async (req,res) => {
  const { placeUrl, keywords=[], preferMap='new', targetCount=0, existingTop5=[] } = req.body;
  if (!placeUrl) return res.status(400).json({error:'URL 필요'});
  if (!keywords || !keywords.length) return res.status(400).json({error:'키워드 배열이 비어있습니다'});
  ctrl={pause:false,stop:false,skip:false};
  const tC = parseInt(targetCount)||0;

  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  const send = d => { try{ res.write('data: '+JSON.stringify(d)+'\n\n'); }catch(e){} };

  try {
    const result = await analyzeWithKeywords(placeUrl, keywords, preferMap, tC, send, existingTop5);
    if (result) {
      const nH = result.top5.filter(x=>x.mapType==='new').length;
      const oH = result.top5.filter(x=>x.mapType==='old').length;
      const prefHits = preferMap==='new'?nH:oH;
      send({phase:'done', info:result.info, top5:result.top5, total:result.checked,
        stopped:result.stopped, remaining:result.remaining||[],
        targetReached:tC>0&&prefHits>=tC, newHits:nH, oldHits:oH});
    }
  } catch(e) {
    console.error(e);
    send({phase:'error',msg:e.message});
  }
  res.end();
});


// ══════════════════════════════════════════════════════════
// ██  /api/batch — 다중 업장 하이브리드 배치 처리  ██
// ══════════════════════════════════════════════════════════
app.post('/api/batch', async (req, res) => {
  const { tasks } = req.body;
  if (!tasks || !tasks.length) return res.status(400).json({error:'작업 목록(tasks) 필요'});

  ctrl = {pause:false, stop:false, skip:false};

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = d => { try { res.write('data: '+JSON.stringify(d)+'\n\n'); } catch(e) {} };

  send({phase:'batch-start', totalTasks: tasks.length});
  console.log(`\n████ 배치 시작: ${tasks.length}개 업장 ████`);

  for (let ti = 0; ti < tasks.length; ti++) {
    const task = tasks[ti];
    if (ctrl.stop) break;
    ctrl.skip = false; // 업장별 skip 리셋

    send({phase:'batch-task-start', taskIndex: ti, totalTasks: tasks.length, url: task.url, mode: task.mode});
    console.log(`\n──── 배치 [${ti+1}/${tasks.length}] mode=${task.mode} url=${task.url} ────`);

    try {
      const idM = task.url.match(/(\d{7,15})/);
      if (!idM) { send({phase:'batch-task-error', taskIndex: ti, msg:'유효하지 않은 URL'}); continue; }

      let keywords;

      // ★ 프론트에서 보낸 키워드 사용 (Manual 전용) ★
      keywords = task.keywords || [];
      console.log(`  [Manual] ${keywords.length.toLocaleString()}개 키워드 전달받음`);

      if (!keywords.length) {
        send({phase:'batch-task-error', taskIndex: ti, msg:'키워드 없음 (0개)'});
        continue;
      }

      const result = await analyzeWithKeywords(
        task.url, keywords, task.preferMap || 'new',
        parseInt(task.targetCount) || 0, send
      );

      if (result) {
        const nH = result.top5.filter(x=>x.mapType==='new').length;
        const oH = result.top5.filter(x=>x.mapType==='old').length;
        const prefHits = (task.preferMap||'new')==='new' ? nH : oH;
        const tC = parseInt(task.targetCount)||0;

        // 최종 자동저장
        const savedPath = _autoSaveXlsx(idM[1], result.info.name, result.top5, result.checked, 0, 0, [task.url]);

        send({phase:'batch-url-done', taskIndex: ti, totalTasks: tasks.length,
          info: result.info, top5: result.top5, total: result.checked,
          newHits: nH, oldHits: oH,
          targetReached: tC>0 && prefHits>=tC,
          bizName: result.info.name,
          savedFile: savedPath ? path.basename(savedPath) : null
        });
        console.log(`  ✅ [${ti+1}/${tasks.length}] ${result.info.name}: 🔵${nH} 🟢${oH} = ${result.top5.length}개`);
      }
    } catch(e) {
      console.error(`  ❌ 배치 [${ti+1}] 오류:`, e.message);
      send({phase:'batch-task-error', taskIndex: ti, msg: e.message});
    }
  }

  send({phase:'batch-done', totalTasks: tasks.length});
  console.log(`\n████ 배치 완료: ${tasks.length}개 업장 ████\n`);
  res.end();
});

// ── 자동저장 엑셀 다운로드 ──
app.get('/api/download-autosave/:filename', (req, res) => {
  const fn = path.basename(req.params.filename); // path traversal 방지
  const fp = path.join(_autosaveDir, fn);
  if (!fs.existsSync(fp)) return res.status(404).json({error:'파일 없음'});
  res.download(fp, fn);
});


// ── 엑셀 불러오기 (Import) API ──
app.post('/api/import-excel', express.json({limit:'50mb'}), (req, res) => {
  try {
    const { data } = req.body;
    if (!data) return res.status(400).json({error:'파일 데이터 없음'});
    const buf = Buffer.from(data, 'base64');
    const wb = XLSX.read(buf, {type:'buffer'});
    let keywords = [];
    let sessionState = null;
    let sessionMeta = {};

    wb.SheetNames.forEach(sn => {
      const ws = wb.Sheets[sn];
      const rows = XLSX.utils.sheet_to_json(ws, {header:1});

      // SessionData 시트
      if (sn === 'SessionData') {
        rows.forEach(row => {
          if (!row[0] || row[0] === 'key') return;
          const k = row[0].toString(), v = (row[1]||'').toString();
          sessionMeta[k] = v;
          if (k === 'keywordsJSON') {
            try { keywords = JSON.parse(v); } catch(e){}
          }
          if (k === 'sessionStateJSON') {
            try { sessionState = JSON.parse(v); } catch(e){}
          }
        });
        return;
      }

      // 키워드 시트 (ABCDEF 포맷: 발견순서,신키워드,순위,발견순서,구키워드,순위)
      if (keywords.length === 0 && sn !== 'URL목록') {
        rows.forEach((row, idx) => {
          if (idx === 0) return;
          // 새 포맷: A=발견순서, B=신지도키워드, C=순위, D=발견순서, E=구지도키워드, F=순위
          // 구 포맷 호환: A=신지도키워드, B=순위, C=구지도키워드, D=순위
          const colCount = (rows[0]||[]).length;
          let nkw, nrk, okw, ork;
          if (colCount >= 6) {
            // 새 포맷 (발견순서 포함)
            nkw = (row[1]||'').toString().trim();
            nrk = parseInt(row[2]) || 0;
            okw = (row[4]||'').toString().trim();
            ork = parseInt(row[5]) || 0;
          } else {
            // 구 포맷 (발견순서 없음)
            nkw = (row[0]||'').toString().trim();
            nrk = parseInt(row[1]) || 0;
            okw = (row[2]||'').toString().trim();
            ork = parseInt(row[3]) || 0;
          }
          if (nkw && nrk >= 1 && nrk <= 5) keywords.push({keyword:nkw, rank:nrk, mapType:'new'});
          if (okw && ork >= 1 && ork <= 5) keywords.push({keyword:okw, rank:ork, mapType:'old'});
        });
      }
    });

    console.log(`[엑셀불러오기] 키워드:${keywords.length}개, 세션상태:${sessionState?'있음':'없음'}, 대기열:${sessionState?.remaining?.length||0}개`);
    res.json({ok:true, keywords, count:keywords.length, sessionState});
  } catch(e) { res.status(500).json({error:'엑셀 파싱 오류: '+e.message}); }
});

// ── 폴더 탐색 API ──
// ── 히스토리 조회 API ──
app.get('/api/history-info', (req, res) => {
  const pid = (req.query.placeId || '').trim();
  if (!pid) return res.json({count:0});
  const arr = _histLoad(pid);
  res.json({placeId:pid, count:arr.length});
});
// ── 히스토리 초기화 API ──
app.post('/api/history-reset', (req, res) => {
  const pid = (req.body.placeId || '').trim();
  if (!pid) return res.status(400).json({error:'placeId 필요'});
  _histSave(pid, []);
  console.log(`[히스토리] ${pid} 초기화 완료`);
  res.json({ok:true, placeId:pid});
});

// ── 체크포인트 불러오기 API ──
app.get('/api/load-checkpoint', (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: '파일 경로 필요' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '파일 없음: ' + filePath });
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // placeId별 요약 반환
    const entries = Object.entries(data).map(([pid, v]) => ({
      placeId: pid,
      count: Array.isArray(v.top5) ? v.top5.length : 0,
      checked: v.checked || 0,
      done: v.done || false,
      ts: v.ts || '',
      top5: v.top5 || [],
    }));
    res.json({ path: filePath, entries });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/status', (req,res) => res.json({status:'running',...ctrl}));
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'public','landing.html')));
app.get('/app', authRequired, (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

// ══════════════════════════════════════════════════════════
// 엑셀 내보내기 API
// ══════════════════════════════════════════════════════════
app.post('/api/export', (req, res) => {
  try {
    const { keywords, perDay, days, bizName, sessionState } = req.body;
    if (!keywords || !keywords.length) return res.status(400).json({ error: '키워드 없음' });
    const pd = Math.max(1, parseInt(perDay) || 100);
    const dy = Math.max(1, parseInt(days) || 1);

    // ── 신지도/구지도 분리 (rank, foundOrder 포함) ──
    const newArr = [], oldArr = [];
    keywords.forEach(k => {
      if (k.mapType === 'new') newArr.push({kw:k.keyword, rank:k.rank, fo:k.foundOrder||''});
      else oldArr.push({kw:k.keyword, rank:k.rank, fo:k.foundOrder||''});
    });

    // ── ABCDEF 포맷: A=발견순서, B=신지도키워드, C=순위, D=발견순서, E=구지도키워드, F=순위 ──
    const wb = XLSX.utils.book_new();
    for (let d = 0; d < dy; d++) {
      const si = d * pd;
      const dayNew = newArr.slice(si, si + pd);
      const dayOld = oldArr.slice(si, si + pd);
      const maxLen = Math.max(dayNew.length, dayOld.length, 1);
      const rows = [['발견순서', '신지도 키워드', '순위', '발견순서', '구지도 키워드', '순위']];
      for (let i = 0; i < maxLen; i++) {
        rows.push([
          dayNew[i]?.fo||'', dayNew[i]?.kw||'', dayNew[i]?.rank||'',
          dayOld[i]?.fo||'', dayOld[i]?.kw||'', dayOld[i]?.rank||''
        ]);
      }
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{wch:8},{wch:30},{wch:6},{wch:8},{wch:30},{wch:6}];
      XLSX.utils.book_append_sheet(wb, ws, `${d+1}일차`);
    }

    // ── SessionData 시트: 메타 정보만 (keywordsJSON 제거 — 32767자 셀 한계 방지) ──
    const sdRows = [['key','value']];
    sdRows.push(['bizName', bizName||'']);
    sdRows.push(['placeId', req.body.placeId||'']);
    sdRows.push(['timestamp', new Date().toISOString()]);
    sdRows.push(['totalNew', String(newArr.length)]);
    sdRows.push(['totalOld', String(oldArr.length)]);
    sdRows.push(['total', String(keywords.length)]);
    const sdWs = XLSX.utils.aoa_to_sheet(sdRows);
    sdWs['!cols'] = [{wch:20},{wch:40}];
    XLSX.utils.book_append_sheet(wb, sdWs, 'SessionData');

    const tmpDir = path.join(__dirname, 'tmp_exports');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const filename = `${_smartDate()}${_smartName(bizName,'')} ${(req.body.done?'추출완료':'추출중')}.xlsx`;
    const filePath = path.join(tmpDir, filename);
    XLSX.writeFile(wb, filePath, { bookType: 'xlsx', type: 'file' });

    res.download(filePath, filename, err => {
      try { fs.unlinkSync(filePath); } catch(e) {}
    });

  } catch(e) {
    console.error('export err:', e);
    res.status(500).json({ error: e.message });
  }
});

// 포트 자동 탐색
const net = require('net');
function findPort(start, cb) {
  const s = net.createServer();
  s.once('error', ()=>findPort(start+1, cb));
  s.once('listening', ()=>{ const p=s.address().port; s.close(()=>cb(p)); });
  s.listen(start);
}
findPort(3000, port => {
  app.listen(port, () => {
    console.log('\n════════════════════════════════════════');
    console.log(`🚀  http://localhost:${port}`);
    console.log('════════════════════════════════════════\n');
    const {exec}=require('child_process');
    exec(`open http://localhost:${port}`, ()=>{});
  });
});
// ★ 크래시 방지 안전망 — 동기 throw + 비동기 rejection 모두 잡기 ★
process.on('uncaughtException', (err) => {
  const msg = err?.message || String(err);
  if (/Target closed|No target|detached Frame|Session closed|Protocol error|EPIPE|ECONNRESET/i.test(msg)) {
    console.error('  [caught-exception]', msg.slice(0, 80));
    return; // 크래시 방지
  }
  console.error('  [FATAL]', msg);
  // 심각한 에러만 프로세스 종료
});
process.on('unhandledRejection', (err) => {
  const msg = err?.message || String(err);
  if (/Target closed|No target|detached Frame|Session closed|Protocol error|EPIPE|ECONNRESET/i.test(msg)) return;
  console.error('  [unhandled]', msg.slice(0, 100));
});
process.on('SIGINT', async()=>{ if(browser) try{await browser.close();}catch(e){} process.exit(0); });
