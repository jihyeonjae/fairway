// 시간 관련 정리의 빈틈 확인 (11.18 추가)
// MODE=lazy      : 정리 작업이 돌기 전에 요청이 오면 그 자리에서 동행을 끝내는지 (getLiveGroup)
//   서버: DEBUG_STATS=1 GROUP_TTL_MS=1000 SWEEP_INTERVAL_MS=600000 node index.js
// MODE=tombstone : "종료됨"·"만료 코드" 안내 기록이 보관 시간 뒤 실제로 지워지는지
//   서버: DEBUG_STATS=1 TOMBSTONE_TTL_MS=500 CODE_TTL_MS=300 SWEEP_INTERVAL_MS=100 node index.js
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:3000';
const WS_URL = BASE.replace(/^http/, 'ws');
const MODE = process.env.MODE;
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}  ${detail}`); }
}
async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* JSON 아님 */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = async () => (await api('GET', '/debug/stats')).json;
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.inbox = [];
    ws.closeCode = null;
    ws.on('message', (d) => { try { ws.inbox.push(JSON.parse(d)); } catch { /* 무시 */ } });
    ws.on('close', (code) => { ws.closeCode = code; });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function lazy() {
  console.log('[1] REST: 정리 전 요청 → 그 자리에서 종료');
  const a = await api('POST', '/api/groups', { vehicleName: '1호차' });
  await sleep(1200); // 동행 수명 1초 지남. 정리 주기는 10분이라 아직 안 돎
  const s0 = await stats();
  check('정리 작업은 아직 안 돌았음 (동행이 메모리에 남아 있음)', s0.groups === 1, JSON.stringify(s0));
  const g = await api('GET', `/api/groups/${a.json.groupId}`);
  check('GET → 410 GROUP_ENDED', g.status === 410 && g.json?.error === 'GROUP_ENDED', JSON.stringify(g.json));
  const s1 = await stats();
  check('요청 한 번으로 동행·코드 삭제', s1.groups === 0 && s1.codes === 0 && s1.endedGroups === 1, JSON.stringify(s1));

  console.log('[2] WS: 연결된 차가 위치를 보내는 순간 종료');
  const b = await api('POST', '/api/groups', { vehicleName: '1호차' });
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'join', groupId: b.json.groupId, vehicleId: b.json.vehicleId }));
  await sleep(1200);
  check('정리 전이라 아직 group_ended 없음', !ws.inbox.some((m) => m.type === 'group_ended'));
  ws.send(JSON.stringify({ type: 'location', data: { lat: 37.5, lng: 127, heading: 0, speed: 10, timestamp: Date.now() } }));
  await sleep(300);
  const ended = ws.inbox.find((m) => m.type === 'group_ended');
  check('위치 요청에 group_ended(EXPIRED) + close 4001', ended?.reason === 'EXPIRED' && ws.closeCode === 4001, JSON.stringify(ws.inbox) + ' close=' + ws.closeCode);
  const s2 = await stats();
  check('위치 저장 안 됨, 동행 삭제', s2.groups === 0 && s2.locations === 0, JSON.stringify(s2));
}

async function tombstone() {
  console.log('[1] 종료 기록 보관 시간 뒤 삭제');
  const a = await api('POST', '/api/groups', { vehicleName: '1호차' });
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'join', groupId: a.json.groupId, vehicleId: a.json.vehicleId }));
  await sleep(100);
  ws.send(JSON.stringify({ type: 'end_group' }));
  await sleep(150);
  const s1 = await stats();
  check('종료 직후 종료 기록 1개', s1.endedGroups === 1, JSON.stringify(s1));
  check('보관 시간 안: GET → 410 GROUP_ENDED', (await api('GET', `/api/groups/${a.json.groupId}`)).json?.error === 'GROUP_ENDED');
  await sleep(900); // 보관 0.5초 + 정리 주기
  const s2 = await stats();
  check('보관 시간 뒤 종료 기록 0개', s2.endedGroups === 0, JSON.stringify(s2));
  check('그 뒤 GET → 404 GROUP_NOT_FOUND', (await api('GET', `/api/groups/${a.json.groupId}`)).json?.error === 'GROUP_NOT_FOUND');

  console.log('[2] 만료 코드 기록 보관 시간 뒤 삭제');
  const b = await api('POST', '/api/groups', { vehicleName: '1호차' });
  await sleep(500); // 코드 0.3초 지나 정리됨, 보관 0.5초는 아직
  const s3 = await stats();
  check('만료 코드 기록 1개', s3.expiredCodes === 1 && s3.codes === 0, JSON.stringify(s3));
  check('보관 시간 안: 참가 → 410 CODE_EXPIRED', (await api('POST', '/api/groups/join', { inviteCode: b.json.inviteCode, vehicleName: '2호차' })).json?.error === 'CODE_EXPIRED');
  await sleep(800);
  const s4 = await stats();
  check('보관 시간 뒤 만료 코드 기록 0개', s4.expiredCodes === 0, JSON.stringify(s4));
  check('그 뒤 참가 → 404 INVALID_CODE', (await api('POST', '/api/groups/join', { inviteCode: b.json.inviteCode, vehicleName: '2호차' })).json?.error === 'INVALID_CODE');
}

(async () => {
  console.log(`대상 서버: ${BASE} (MODE=${MODE})\n`);
  if (!(await stats())) { console.log('❌ /debug/stats 없음 → 서버를 DEBUG_STATS=1 로 켜세요'); process.exit(1); }
  if (MODE === 'lazy') await lazy();
  else if (MODE === 'tombstone') await tombstone();
  else { console.log('❌ MODE=lazy 또는 MODE=tombstone 으로 실행하세요'); process.exit(1); }
  console.log(`\n결과: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('❌ 테스트 중단:', e.message); process.exit(1); });
