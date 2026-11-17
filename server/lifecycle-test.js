// 동행 종료·나가기·데이터 삭제 테스트 (11.17)
// 사용법: 서버를  DEBUG_STATS=1 node index.js  로 켠 뒤 다른 창에서  node lifecycle-test.js
// 이 서버에서 다른 테스트를 같이 돌리지 말 것 (메모리 개수를 비교한다). npm test가 알아서 따로 켠다
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
const sendJson = (ws, obj) => ws.send(JSON.stringify(obj));
function waitFor(ws, pred, ms = 1500) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const i = ws.inbox.findIndex(pred);
      if (i >= 0) return resolve(ws.inbox.splice(i, 1)[0]);
      if (Date.now() - start > ms) return resolve(null);
      setTimeout(tick, 30);
    };
    tick();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isErr = (code) => (m) => m.type === 'error' && m.error === code;
const stats = async () => (await api('GET', '/debug/stats')).json;
const loc = (lat, heading = 0) => ({ lat, lng: 127.0, heading, speed: 20, accuracy: 5, timestamp: Date.now() });

// 차 n대짜리 동행. 전부 WS 연결
async function makeGroup(prefix, n) {
  const c = await api('POST', '/api/groups', { vehicleName: `${prefix}1` });
  const ids = [c.json.vehicleId];
  for (let i = 2; i <= n; i++) {
    const j = await api('POST', '/api/groups/join', { inviteCode: c.json.inviteCode, vehicleName: `${prefix}${i}` });
    if (j.status !== 200) throw new Error(`테스트 준비 실패: ${prefix}${i} 참가 ${JSON.stringify(j.json)}`);
    ids.push(j.json.vehicleId);
  }
  const conns = [];
  for (const id of ids) {
    const ws = await connect();
    sendJson(ws, { type: 'join', groupId: c.json.groupId, vehicleId: id });
    await waitFor(ws, (m) => m.type === 'group_state');
    conns.push(ws);
  }
  return { g: c.json.groupId, code: c.json.inviteCode, ids, conns };
}

async function main() {
  console.log(`대상 서버: ${BASE}\n`);
  const s0 = await stats();
  if (!s0) { console.log('❌ /debug/stats 없음 → 서버를 DEBUG_STATS=1 로 켜세요'); process.exit(1); }

  console.log('[1] 호스트가 아니면 종료 불가');
  const A = await makeGroup('A', 2);
  const [host, guest] = A.conns;
  sendJson(host, { type: 'location', data: loc(37.5) });
  sendJson(guest, { type: 'location', data: loc(37.49) });
  sendJson(host, { type: 'vehicle_status', data: { warning: 'ESC_BLINK' } });
  await waitFor(host, (m) => m.type === 'hazard_created');
  sendJson(guest, { type: 'end_group' });
  check('참가자가 end_group → NOT_HOST', !!(await waitFor(guest, isErr('NOT_HOST'))));
  check('동행은 그대로', (await api('GET', `/api/groups/${A.g}`)).status === 200);
  const s1 = await stats();
  check('종료 전 메모리: 동행·차·위치·위험 있음', s1.groups === 1 && s1.vehicles === 2 && s1.locations === 2 && s1.hazards === 1, JSON.stringify(s1));

  console.log('[2] 호스트 종료');
  sendJson(host, { type: 'end_group' });
  const eh = await waitFor(host, (m) => m.type === 'group_ended');
  const eg = await waitFor(guest, (m) => m.type === 'group_ended');
  check('호스트·참가자 모두 group_ended(HOST_ENDED)', eh?.reason === 'HOST_ENDED' && eg?.reason === 'HOST_ENDED', JSON.stringify([eh, eg]));
  await sleep(200);
  check('두 연결 모두 close 코드 4001', host.closeCode === 4001 && guest.closeCode === 4001, `${host.closeCode}, ${guest.closeCode}`);
  const s2 = await stats();
  check('메모리에서 동행·참가 코드·차·위치·위험·연결 전부 삭제', s2.groups === 0 && s2.codes === 0 && s2.vehicles === 0 && s2.locations === 0 && s2.hazards === 0 && s2.socketGroups === 0, JSON.stringify(s2));
  check('남는 건 종료 안내용 groupId 1개뿐', s2.endedGroups === 1, JSON.stringify(s2));

  console.log('[3] 종료 뒤 요청');
  check('GET 동행 → 410 GROUP_ENDED', (await api('GET', `/api/groups/${A.g}`)).json?.error === 'GROUP_ENDED');
  const rj = await api('POST', '/api/groups/join', { inviteCode: A.code, vehicleName: '늦은차' });
  check('예전 참가 코드 → 404 INVALID_CODE', rj.status === 404 && rj.json?.error === 'INVALID_CODE', JSON.stringify(rj.json));
  const late = await connect();
  sendJson(late, { type: 'join', groupId: A.g, vehicleId: A.ids[1] });
  check('저장해 둔 ID로 WS join → GROUP_ENDED', !!(await waitFor(late, isErr('GROUP_ENDED'))));
  sendJson(late, { type: 'location', data: loc(37.5) });
  check('늦게 온 위치 → NOT_JOINED (저장 안 됨)', !!(await waitFor(late, isErr('NOT_JOINED'))));
  sendJson(late, { type: 'end_group' });
  check('끝난 동행에 또 종료 요청 → NOT_JOINED, 서버 유지', !!(await waitFor(late, isErr('NOT_JOINED'))));
  late.close();
  check('종료 뒤에도 위치가 다시 생기지 않음', (await stats()).locations === 0);

  console.log('[4] 참가자 나가기 (leave_group)');
  const B = await makeGroup('B', 5);
  const [bHost, bGuest, b3] = B.conns;
  sendJson(bHost, { type: 'leave_group' });
  check('호스트가 leave_group → HOST_CANNOT_LEAVE', !!(await waitFor(bHost, isErr('HOST_CANNOT_LEAVE'))));
  const full = await api('POST', '/api/groups/join', { inviteCode: B.code, vehicleName: 'B6' });
  check('5대 꽉 참 → GROUP_FULL', full.json?.error === 'GROUP_FULL');
  sendJson(bGuest, { type: 'location', data: loc(37.6) });
  sendJson(bGuest, { type: 'vehicle_status', data: { warning: 'ESC_BLINK' } });
  const hz = await waitFor(bGuest, (m) => m.type === 'hazard_created');
  bHost.inbox.length = 0;
  sendJson(bGuest, { type: 'leave_group' });
  check('나간 차에 left_group', !!(await waitFor(bGuest, (m) => m.type === 'left_group')));
  const gs = await waitFor(bHost, (m) => m.type === 'group_state');
  check('남은 차들 명단에서 B2 빠짐', gs && !gs.vehicles.includes('B2') && gs.vehicles.length === 4, JSON.stringify(gs));
  const cl = await waitFor(b3, (m) => m.type === 'hazard_cleared');
  check('나간 차가 낸 위험은 삭제 알림', cl && cl.hazardId === hz?.hazardId, JSON.stringify(cl));
  const sB = await stats();
  check('나간 차의 위치·위험 삭제', sB.vehicles === 4 && sB.locations === 0 && sB.hazards === 0, JSON.stringify(sB));
  sendJson(bGuest, { type: 'location', data: loc(37.6) });
  check('나간 뒤 보낸 위치 → NOT_JOINED', !!(await waitFor(bGuest, isErr('NOT_JOINED'))));
  const back = await api('POST', '/api/groups/join', { inviteCode: B.code, vehicleName: 'B2' });
  check('자리가 비어 같은 이름으로 다시 참가 가능', back.status === 200, JSON.stringify(back.json));
  const old = await connect();
  sendJson(old, { type: 'join', groupId: B.g, vehicleId: B.ids[1] });
  check('나간 차의 예전 vehicleId로 join → NOT_A_MEMBER', !!(await waitFor(old, isErr('NOT_A_MEMBER'))));
  old.close();

  console.log('[5] 서버 생존');
  check('/health ok', (await api('GET', '/health')).json?.status === 'ok');

  for (const ws of B.conns) ws.close();
  console.log(`\n결과: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log('❌ 테스트 중단:', e.message); process.exit(1); });
