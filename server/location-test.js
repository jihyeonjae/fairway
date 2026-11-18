// 차량 위치 공유 테스트 (11.17)
// 사용법: 서버를 켠 상태에서 다른 창에서  node location-test.js   (다른 주소면 BASE=http://<IP>:3000)
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

// 동행 하나 만들고 차 2대를 WS로 연결
async function makeGroup(prefix) {
  const c = await api('POST', '/api/groups', { vehicleName: `${prefix}1` });
  const j = await api('POST', '/api/groups/join', { inviteCode: c.json.inviteCode, vehicleName: `${prefix}2` });
  const g = c.json.groupId;
  const a = await connect();
  const b = await connect();
  sendJson(a, { type: 'join', groupId: g, vehicleId: c.json.vehicleId });
  sendJson(b, { type: 'join', groupId: g, vehicleId: j.json.vehicleId });
  await waitFor(a, (m) => m.type === 'group_state');
  await waitFor(b, (m) => m.type === 'group_state');
  return { g, v1: c.json.vehicleId, v2: j.json.vehicleId, a, b, code: c.json.inviteCode };
}
const loc = (over = {}) => ({ lat: 37.5665, lng: 126.978, heading: 90, speed: 20, accuracy: 5, timestamp: Date.now(), ...over });

async function main() {
  console.log(`대상 서버: ${BASE}\n`);
  const A = await makeGroup('A');
  const B = await makeGroup('B');

  console.log('[1] 같은 동행에 전달');
  const sent = loc();
  sendJson(A.a, { type: 'location', data: sent });
  const got = await waitFor(A.b, isLoc);
  check('2호차가 1호차 위치를 받음', got && got.vehicleId === A.v1 && got.data.lat === sent.lat && got.data.lng === sent.lng, JSON.stringify(got));
  check('방향·속도·측정시각·서버수신시각 포함', got && got.data.heading === 90 && got.data.speed === 20
    && got.data.measuredAt === sent.timestamp && typeof got.data.receivedAt === 'number', JSON.stringify(got?.data));
  check('보낸 차 자신에게는 안 돌아옴', !(await waitFor(A.a, isLoc, 300)));

  console.log('[2] 다른 동행 격리');
  check('다른 동행(B) 차는 위치를 못 받음', !(await waitFor(B.a, isLoc, 400)) && !(await waitFor(B.b, isLoc, 50)));

  console.log('[3] 정지 중(방향 없음)도 받음');
  sendJson(A.a, { type: 'location', data: loc({ heading: null, speed: 0 }) });
  const still = await waitFor(A.b, isLoc);
  check('heading null 허용', still && still.data.heading === null, JSON.stringify(still));

  console.log('[4] 잘못된 값 거절');
  const bad = [
    ['위도 91', loc({ lat: 91 }), 'BAD_LOCATION'],
    ['경도 -181', loc({ lng: -181 }), 'BAD_LOCATION'],
    ['문자열 위도 "37.5"', loc({ lat: '37.5' }), 'BAD_LOCATION'],
    ['방향 360', loc({ heading: 360 }), 'BAD_LOCATION'],
    ['음수 속도', loc({ speed: -1 }), 'BAD_LOCATION'],
    ['(0, 0) 좌표', loc({ lat: 0, lng: 0 }), 'BAD_LOCATION'],
    ['측정 시각 없음', loc({ timestamp: undefined }), 'BAD_LOCATION'],
    ['측정 시각 빈 문자열', loc({ timestamp: '' }), 'BAD_LOCATION'],
    ['초 단위 timestamp', loc({ timestamp: Math.floor(Date.now() / 1000) }), 'BAD_LOCATION'],
    ['60초 전 위치', loc({ timestamp: Date.now() - 60000 }), 'LOCATION_TOO_OLD'],
    ['1분 뒤 미래 시각', loc({ timestamp: Date.now() + 60000 }), 'LOCATION_FROM_FUTURE'],
  ];
  // 1초에 5번 제한에 걸리지 않게 0.25초 간격으로 보낸다
  for (const [name, data, code] of bad) {
    await sleep(250);
    sendJson(A.a, { type: 'location', data });
    check(`${name} → ${code}`, !!(await waitFor(A.a, isErr(code))));
  }
  for (const [name, data] of [['data 없음', undefined], ['data null', null], ['data 배열', [1, 2]], ['data 숫자', 5]]) {
    await sleep(250);
    sendJson(A.a, { type: 'location', data });
    check(`${name} → BAD_LOCATION`, !!(await waitFor(A.a, isErr('BAD_LOCATION'))));
  }
  check('잘못된 위치는 다른 차로 안 퍼짐', !(await waitFor(A.b, isLoc, 300)));

  console.log('[5] 사칭·미참가');
  sendJson(A.a, { type: 'location', vehicleId: A.v2, data: loc() });
  check('남의 vehicleId로 보내면 BAD_LOCATION', !!(await waitFor(A.a, isErr('BAD_LOCATION'))));
  check('사칭 위치는 안 퍼짐', !(await waitFor(A.b, isLoc, 300)));
  const stranger = await connect();
  sendJson(stranger, { type: 'location', data: loc() });
  check('join 안 한 연결 → NOT_JOINED', !!(await waitFor(stranger, isErr('NOT_JOINED'))));
  stranger.close();

  console.log('[6] 늦게 도착한 옛 위치');
  const t = Date.now();
  sendJson(A.a, { type: 'location', data: loc({ lat: 37.6, timestamp: t }) });
  await waitFor(A.b, isLoc);
  sendJson(A.a, { type: 'location', data: loc({ lat: 37.1, timestamp: t - 500 }) });
  check('더 옛날 측정값은 무시 (전달 안 됨)', !(await waitFor(A.b, isLoc, 400)));

  console.log('[7] 다시 접속하면 다른 차 마지막 위치를 받음');
  A.b.close();
  await sleep(100);
  const b2 = await connect();
  sendJson(b2, { type: 'join', groupId: A.g, vehicleId: A.v2 });
  const replay = await waitFor(b2, isLoc);
  check('재접속 직후 1호차 마지막 위치(37.6) 수신', replay && replay.vehicleId === A.v1 && replay.data.lat === 37.6, JSON.stringify(replay));

  console.log('[8] 너무 자주 보내기');
  await sleep(1100); // 새 1초 구간에서 시작
  A.a.inbox.length = 0;
  b2.inbox.length = 0;
  for (let i = 0; i < 9; i++) sendJson(A.a, { type: 'location', data: loc({ lat: 37 + i / 100, timestamp: Date.now() + i }) });
  await sleep(400);
  const limited = A.a.inbox.filter(isErr('RATE_LIMITED')).length;
  const received = b2.inbox.filter(isLoc).length;
  check('RATE_LIMITED 에러는 1번만', limited === 1, `에러 ${limited}번`);
  check('초과분은 전달 안 됨 (5개 이하)', received <= 5 && received >= 1, `받은 개수 ${received}`);

  console.log('[9] 서버 생존');
  const h = await api('GET', '/health');
  check('잘못된 입력 뒤에도 /health ok', h.json?.status === 'ok');

  for (const ws of [A.a, b2, B.a, B.b]) ws.close();
  console.log(`\n결과: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log('❌ 테스트 중단:', e.message); process.exit(1); });
