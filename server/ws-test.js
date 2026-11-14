// WebSocket 테스트용 클라이언트 (앱 대신 연결해보는 용도)
// 사용법: node ws-test.js g1 v1
// 연결된 뒤 키보드로 입력하고 Enter:
//   r          → 준비 완료      {"ready": true}
//   n          → 준비 안 됨     {"ready": false}
//   w 코드     → 경고 보내기    {"warning": "코드"}   예) w TIRE_LOW
//   { ... }    → 입력한 JSON을 그대로 보내기 (잘못된 값 테스트용)
//   leave      → 알림 끊기
const WebSocket = require('ws');
const readline = require('readline');

const [groupId, vehicleId] = process.argv.slice(2);
if (!groupId || !vehicleId) {
  console.log('사용법: node ws-test.js <groupId> <vehicleId>   예) node ws-test.js g1 v1');
  process.exit(1);
}

const url = process.env.WS_URL || 'ws://localhost:3000';
const ws = new WebSocket(url);

function status(data) {
  return JSON.stringify({ type: 'vehicle_status', vehicleId, data });
}

ws.on('open', () => {
  console.log(`[연결됨] ${url} → ${groupId}/${vehicleId}로 join 보냄`);
  console.log('  입력: r(준비) / n(준비 안 됨) / w 코드(경고) / {JSON}(그대로 전송) / leave');
  ws.send(JSON.stringify({ type: 'join', groupId, vehicleId }));

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    let out;
    if (t === 'r') out = status({ ready: true });
    else if (t === 'n') out = status({ ready: false });
    else if (t.startsWith('w ')) out = status({ warning: t.slice(2).trim() });
    else if (t === 'leave') out = JSON.stringify({ type: 'leave' });
    else out = t; // 그대로 보내기
    console.log('[보냄]', out);
    ws.send(out);
  });
});
ws.on('message', (data) => console.log('[받음]', data.toString()));
ws.on('close', () => { console.log('[연결 끊김]'); process.exit(0); });
ws.on('error', (e) => console.log('[에러]', e.message));
