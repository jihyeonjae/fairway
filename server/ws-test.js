// WebSocket 테스트용 클라이언트 (앱 대신 연결해보는 용도)
// 사용법: node ws-test.js g1 v1
const WebSocket = require('ws');

const [groupId, vehicleId] = process.argv.slice(2);
if (!groupId || !vehicleId) {
  console.log('사용법: node ws-test.js <groupId> <vehicleId>   예) node ws-test.js g1 v1');
  process.exit(1);
}

const url = process.env.WS_URL || 'ws://localhost:3000';
const ws = new WebSocket(url);

ws.on('open', () => {
  console.log(`[연결됨] ${url} → ${groupId}/${vehicleId}로 join 보냄`);
  ws.send(JSON.stringify({ type: 'join', groupId, vehicleId }));
});
ws.on('message', (data) => console.log('[받음]', data.toString()));
ws.on('close', () => console.log('[연결 끊김]'));
ws.on('error', (e) => console.log('[에러]', e.message));
