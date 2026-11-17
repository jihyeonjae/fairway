// 시간 경과 정리 테스트: 12시간 자동 종료, 30분 참가 코드 정리 (시간을 짧게 당겨서 확인)
// 사용법: 서버를  DEBUG_STATS=1 GROUP_TTL_MS=1500 CODE_TTL_MS=600 SWEEP_INTERVAL_MS=200 node index.js  로 켠 뒤
//        다른 창에서  node lifecycle-expire-test.js
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:3000';
const WS_URL = BASE.replace(/^http/, 'ws');
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

async function main() {
  console.log(`대상 서버: ${BASE}\n`);
  if (!(await stats())) { console.log('❌ /debug/stats 없음 → 서버를 DEBUG_STATS=1 로 켜세요'); process.exit(1); }

  const c = await api('POST', '/api/groups', { vehicleName: '1호차' });
  const ws = new WebSocket(WS_URL);
  ws.inbox = [];
  ws.closeCode = null;
  ws.on('message', (d) => ws.inbox.push(JSON.parse(d)));
  ws.on('close', (code) => { ws.closeCode = code; });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', groupId: c.json.groupId, vehicleId: c.json.vehicleId }));
  ws.send(JSON.stringify({ type: 'location', data: { lat: 37.5, lng: 127, heading: 0, speed: 10, timestamp: Date.now() } }));

  console.log('[1] 참가 코드 정리 (CODE_TTL_MS 지난 뒤)');
  await sleep(1000); // 코드 600ms + 정리 주기 200ms가 충분히 지남, 동행 1500ms는 아직
  const s1 = await stats();
  check('정리 작업이 코드 찾기 목록에서 코드 삭제', s1.codes === 0 && s1.expiredCodes === 1, JSON.stringify(s1));
  check('동행 자체는 아직 살아 있음', s1.groups === 1, JSON.stringify(s1));
  const j = await api('POST', '/api/groups/join', { inviteCode: c.json.inviteCode, vehicleName: '2호차' });
  check('지운 코드로 참가 → 410 CODE_EXPIRED (없는 코드와 구분)', j.status === 410 && j.json?.error === 'CODE_EXPIRED', JSON.stringify(j.json));

  console.log('[2] 동행 자동 종료 (GROUP_TTL_MS 지난 뒤)');
  await sleep(1000);
  const ended = ws.inbox.find((m) => m.type === 'group_ended');
  check('연결된 앱에 group_ended(EXPIRED)', ended?.reason === 'EXPIRED', JSON.stringify(ws.inbox));
  check('close 코드 4001', ws.closeCode === 4001, String(ws.closeCode));
  const s2 = await stats();
  check('동행·코드·차·위치 전부 삭제', s2.groups === 0 && s2.codes === 0 && s2.vehicles === 0 && s2.locations === 0 && s2.socketGroups === 0, JSON.stringify(s2));
  check('만료 코드 안내 기록도 함께 정리', s2.expiredCodes === 0, JSON.stringify(s2));
  check('GET 동행 → 410 GROUP_ENDED', (await api('GET', `/api/groups/${c.json.groupId}`)).json?.error === 'GROUP_ENDED');

  console.log('[3] 정리 작업이 여러 번 돌아도 안전');
  await sleep(600); // 정리가 3번 더 돎
  const s3 = await stats();
  check('종료 기록 1개 유지, 서버 정상', s3.endedGroups === 1 && (await api('GET', '/health')).json?.status === 'ok', JSON.stringify(s3));

  console.log(`\n결과: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log('❌ 테스트 중단:', e.message); process.exit(1); });
