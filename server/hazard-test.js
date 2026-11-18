// 위험 감지·뒤차 경고 테스트 (11.17)
// 사용법: 서버를 켠 상태에서 다른 창에서  node hazard-test.js   (다른 주소면 BASE=http://<IP>:3000)
// 좌표는 북쪽(0°)으로 뻗은 가상의 직선 도로. 실제 도로가 아니다
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
    ws.on('message', (d) => { try { ws.inbox.push(JSON.parse(d)); } catch { /* 무시 */ } });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
const sendJson = (ws, obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
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
const isLoc = (m) => m.type === 'vehicle_location_updated';
const isErr = (code) => (m) => m.type === 'error' && m.error === code;
const isAlert = (m) => m.type === 'hazard_alert';

// 기준점에서 bearing 방향으로 meters만큼 떨어진 좌표 (짧은 거리용 근사)
const BASE_PT = { lat: 37.5, lng: 127.0 };
function offset(meters, bearing = 180, from = BASE_PT) {
  const b = bearing * Math.PI / 180;
  return {
    lat: from.lat + (meters * Math.cos(b)) / 111320,
    lng: from.lng + (meters * Math.sin(b)) / (111320 * Math.cos(from.lat * Math.PI / 180)),
  };
}
const locAt = (pt, heading = 0, speed = 20) => ({ ...pt, heading, speed, accuracy: 5, timestamp: Date.now() });
const sendLoc = (ws, pt, heading, speed) => sendJson(ws, { type: 'location', data: locAt(pt, heading, speed) });
const warn = (ws, code) => sendJson(ws, { type: 'vehicle_status', data: { warning: code } });

// 동행 하나에 차 n대
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
  return { g: c.json.groupId, ids, conns };
}

async function main() {
  console.log(`대상 서버: ${BASE}\n`);

  console.log('[1] 기본: 앞차 위험 → 1.3km 뒤 같은 방향 차에 경고 1회');
  const G = await makeGroup('A', 5); // 동행 최대 5대: 0 앞차, 1 뒤차(1.3km), 2 반대방향, 3 이미 지난 차, 4 정지
  const [lead, back, opp, passed, stopped] = G.conns;
  sendLoc(lead, BASE_PT, 0);
  sendLoc(back, offset(1300, 180), 0);             // 남쪽 1.3km에서 북쪽으로 오는 중
  sendLoc(opp, offset(1300, 180), 180);            // 같은 자리, 남쪽으로 멀어지는 중
  sendLoc(passed, offset(500, 0), 0);              // 이미 위험 지점을 지나 북쪽 500m
  sendLoc(stopped, offset(800, 180), null, 0);     // 800m 뒤에 서 있음 (방향 없음)
  await sleep(200);
  warn(lead, 'ESC_BLINK');
  const created = await waitFor(lead, (m) => m.type === 'hazard_created');
  check('앞차에 hazard_created 응답', created && created.code === 'ESC_BLINK' && created.duplicate === false, JSON.stringify(created));
  const a1 = await waitFor(back, isAlert);
  check('뒤차에 hazard_alert', a1 && a1.hazardId === created?.hazardId && a1.fromVehicleId === G.ids[0], JSON.stringify(a1));
  check('거리 약 1300m', a1 && Math.abs(a1.distanceM - 1300) < 20, `distanceM=${a1?.distanceM}`);
  await sleep(300);
  check('반대 방향 차는 경고 없음', !opp.inbox.some(isAlert));
  check('이미 지난 차는 경고 없음', !passed.inbox.some(isAlert));
  check('정지 중(방향 없음) 차는 경고 보류', !stopped.inbox.some(isAlert));
  check('앞차 자신은 경고 없음', !lead.inbox.some(isAlert));

  console.log('[2] 중복: 같은 자리에서 3번 더 켜도 기록·경고 1번');
  for (let i = 0; i < 3; i++) {
    warn(lead, 'NONE'); await sleep(50);
    sendLoc(lead, BASE_PT, 0); warn(lead, 'ESC_BLINK');
    const r = await waitFor(lead, (m) => m.type === 'hazard_created');
    check(`${i + 1}번째 재전송 → duplicate:true, 같은 hazardId`, r && r.duplicate === true && r.hazardId === created?.hazardId, JSON.stringify(r));
    sendLoc(back, offset(1250 - i * 50, 180), 0);
  }
  await sleep(300);
  check('뒤차가 계속 다가와도 추가 경고 없음', !back.inbox.some(isAlert));

  console.log('[3] 정지 차가 출발하면 그때 경고');
  sendLoc(stopped, offset(780, 180), 0, 10);
  const a3 = await waitFor(stopped, isAlert);
  check('움직이기 시작하자 경고', !!a3, JSON.stringify(a3));

  console.log('[4] 3km 밖에서 출발 → 1.3km 안에 들어올 때 경고');
  const H = await makeGroup('B', 3); // 2번 차는 위치를 한 번도 안 보냄
  sendLoc(H.conns[0], BASE_PT, 0);
  sendLoc(H.conns[1], offset(3000, 180), 0);
  await sleep(150);
  warn(H.conns[0], 'ESC_BLINK');
  await waitFor(H.conns[0], (m) => m.type === 'hazard_created');
  check('3km에서는 경고 없음', !(await waitFor(H.conns[1], isAlert, 300)));
  sendLoc(H.conns[1], offset(2000, 180), 0);
  check('2km에서도 없음', !(await waitFor(H.conns[1], isAlert, 300)));
  sendLoc(H.conns[1], offset(1300, 180), 0);
  const a4 = await waitFor(H.conns[1], isAlert);
  check('1.3km 진입 시 경고', a4 && Math.abs(a4.distanceM - 1300) < 20, JSON.stringify(a4));
  await sleep(200);
  check('위치 없는 차는 경고 없음 (추측 안 함)', !H.conns[2].inbox.some(isAlert));
  check('다른 동행(A)으로 안 샘', !G.conns.some((ws) => ws.inbox.some((m) => isAlert(m) && m.hazardId === a4?.hazardId)));

  console.log('[5] 위치보다 경고가 먼저 옴');
  const P = await makeGroup('C', 2);
  sendLoc(P.conns[1], offset(1000, 180), 0);
  warn(P.conns[0], 'HAZARD_TELLTALE');
  const pend = await waitFor(P.conns[0], (m) => m.type === 'hazard_pending');
  check('hazard_pending NO_RECENT_LOCATION', pend && pend.reason === 'NO_RECENT_LOCATION', JSON.stringify(pend));
  sendLoc(P.conns[1], offset(1000, 180), 0); // 뒤차 위치를 최신으로
  sendLoc(P.conns[0], BASE_PT, 0);
  const pc = await waitFor(P.conns[0], (m) => m.type === 'hazard_created');
  check('3초 안에 위치가 오면 위험 생성', !!pc, JSON.stringify(pc));
  const pa = await waitFor(P.conns[1], isAlert);
  check('뒤차 경고', !!pa);

  console.log('[6] 비상등 끄면 위험 삭제 알림');
  warn(P.conns[0], 'NONE');
  const cl = await waitFor(P.conns[1], (m) => m.type === 'hazard_cleared');
  check('hazard_cleared 수신', cl && cl.hazardId === pc?.hazardId, JSON.stringify(cl));

  console.log('[7] 위치를 3초 넘게 안 보내면 위험 안 만듦');
  const Q = await makeGroup('D', 1);
  warn(Q.conns[0], 'ESC_BLINK');
  await waitFor(Q.conns[0], (m) => m.type === 'hazard_pending');
  await sleep(3300);
  sendLoc(Q.conns[0], BASE_PT, 0);
  const late = await waitFor(Q.conns[0], (m) => m.type === 'hazard_not_created');
  check('hazard_not_created LOCATION_TIMEOUT', late && late.reason === 'LOCATION_TIMEOUT', JSON.stringify(late));
  check('hazard_created 없음', !Q.conns[0].inbox.some((m) => m.type === 'hazard_created'));

  console.log('[8] 움직인 적 없는 차(방향 모름)는 위험 안 만듦');
  const R = await makeGroup('E', 1);
  sendLoc(R.conns[0], BASE_PT, null, 0);
  await sleep(100);
  warn(R.conns[0], 'ESC_BLINK');
  const nh = await waitFor(R.conns[0], (m) => m.type === 'hazard_not_created');
  check('hazard_not_created NO_HEADING', nh && nh.reason === 'NO_HEADING', JSON.stringify(nh));

  console.log('[9] 위험 코드가 아닌 warning');
  sendLoc(R.conns[0], BASE_PT, 0);
  warn(R.conns[0], 'TIRE_LOW');
  await sleep(300);
  check('TIRE_LOW는 위험 안 만듦 (상태로만 전달)', !R.conns[0].inbox.some((m) => m.type && m.type.startsWith('hazard_')));

  console.log('[10] 서버 생존');
  const h = await api('GET', '/health');
  check('/health ok', h.json?.status === 'ok');

  for (const grp of [G, H, P, Q, R]) for (const ws of grp.conns) ws.close();
  console.log(`\n결과: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log('❌ 테스트 중단:', e.message); process.exit(1); });
