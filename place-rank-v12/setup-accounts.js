/**
 * 이지보드 계정 생성 스크립트
 * 
 * 사용법: 서버 디렉토리에서 실행
 *   node setup-accounts.js
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function hashPw(pw) {
  return crypto.createHash('sha256').update(pw + 'easyboard_salt_2026').digest('hex');
}

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch(e) { return []; }
}

const users = loadUsers();

// ── 관리자 계정: admin / dh36936944! ──
const adminIdx = users.findIndex(u => u.username === 'admin');
const adminData = {
  username: 'admin',
  email: 'admin@easyboard.co.kr',
  name: '관리자',
  company: '이지보드',
  phone: '01000000000',
  referrer: '',
  memberType: 'general',
  bizDoc: '',
  password: hashPw('dh36936944!'),
  role: 'admin',
  approved: true,
  createdAt: new Date().toISOString().split('T')[0]
};

if (adminIdx >= 0) {
  users[adminIdx].password = adminData.password;
  users[adminIdx].role = 'admin';
  users[adminIdx].approved = true;
  console.log('✅ admin 계정 비밀번호 변경 완료 (dh36936944!)');
} else {
  users.push(adminData);
  console.log('✅ admin 계정 생성 완료 (dh36936944!)');
}

// ── 저장 ──
fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
console.log(`\n📁 저장 완료: ${USERS_FILE}`);
console.log(`👥 총 ${users.length}명 등록됨\n`);
console.log('계정 정보:');
console.log('  관리자: admin / dh36936944!');
console.log('');
