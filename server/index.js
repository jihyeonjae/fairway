const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const app = express();
app.use(cors());
app.use(express.json());

// ── 메모리 저장소 (서버 끄면 사라짐) ──
const groups = new Map();      // groupId → 동행 정보
const codeToGroup = new Map(); // inviteCode → groupId (코드로 동행 찾기용)
let groupSeq = 0;              // g1, g2, ... 만들 때 쓰는 번호
let vehicleSeq = 0;            // v1, v2, ... 동행이 달라도 서버 전체에서 겹치지 않음

// 6자리 코드 만들기. 이미 쓰는 코드면 다시 뽑는다
function newInviteCode() {
  let code;
  do {
    code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  } while (codeToGroup.has(code));
  return code;
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── 동행 만들기 ──
app.post('/api/groups', (req, res) => {
  const vehicleName = req.body?.vehicleName; // ?. = body가 없어도 에러 없이 undefined
  if (!vehicleName) {
    return res.status(400).json({ error: 'MISSING_VEHICLE_NAME', message: 'vehicleName이 필요합니다' });
  }

  const groupId = 'g' + (++groupSeq);
  const vehicleId = 'v' + (++vehicleSeq);
  const inviteCode = newInviteCode();

  groups.set(groupId, {
    groupId,
    inviteCode,
    createdAt: Date.now(),          // 30분 만료 계산에 씀 (다음 단계)
    hostVehicleId: vehicleId,       // 만든 차량 = 호스트
    vehicles: new Map([[vehicleId, { vehicleId, vehicleName }]]),
  });
  codeToGroup.set(inviteCode, groupId);

  res.json({ groupId, inviteCode, vehicleId });
});

// ── 참가 규칙 (계획서 가정값) ──
const CODE_TTL_MS = 30 * 60 * 1000; // 코드 유효시간 30분 (가정)
const MAX_VEHICLES = 5;             // 동행 최대 5대 (가정)

// 동행 안 차량들의 이름만 뽑아서 배열로: ["1호차", "2호차"]
function vehicleNames(group) {
  return [...group.vehicles.values()].map(v => v.vehicleName);
}

// ── 동행 참가하기 ──
app.post('/api/groups/join', (req, res) => {
  const inviteCode = req.body?.inviteCode;
  const vehicleName = req.body?.vehicleName;
  if (!vehicleName) {
    return res.status(400).json({ error: 'MISSING_VEHICLE_NAME', message: 'vehicleName이 필요합니다' });
  }

  // 코드로 동행 찾기
  const groupId = codeToGroup.get(String(inviteCode));
  const group = groups.get(groupId);
  if (!group) {
    return res.status(404).json({ error: 'INVALID_CODE', message: '없는 참가 코드입니다' });
  }
  if (Date.now() - group.createdAt > CODE_TTL_MS) {
    return res.status(410).json({ error: 'CODE_EXPIRED', message: '참가 코드 유효시간이 지났습니다' });
  }
  if (group.vehicles.size >= MAX_VEHICLES) {
    return res.status(409).json({ error: 'GROUP_FULL', message: `동행은 최대 ${MAX_VEHICLES}대까지입니다` });
  }

  // 통과하면 참가 목록에 추가
  const vehicleId = 'v' + (++vehicleSeq);
  group.vehicles.set(vehicleId, { vehicleId, vehicleName });

  res.json({ groupId, vehicleId, vehicles: vehicleNames(group) });
  broadcastGroupState(groupId); // 이미 연결된 차량들에게 새 명단 알림
});

// ── 참가 차량 목록 보기 ──
app.get('/api/groups/:groupId', (req, res) => {
  const group = groups.get(req.params.groupId);
  if (!group) {
    return res.status(404).json({ error: 'GROUP_NOT_FOUND', message: '없는 동행입니다' });
  }
  res.json({ groupId: group.groupId, vehicles: vehicleNames(group) });
});

// ── REST 에러 처리 ──
// 깨진 JSON 등으로 Express 안에서 에러가 나면 HTML 대신 JSON으로 답한다 (앱이 토스트로 띄울 수 있게)
// 에러 처리 미들웨어는 인자가 4개여야 하고, 모든 라우트 뒤에 둔다
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'BAD_JSON', message: 'JSON 형식이 아닙니다' });
  }
  console.error('[REST 에러]', err);
  res.status(500).json({ error: 'SERVER_ERROR', message: '서버 처리 중 오류가 났습니다' });
});

// ── 실시간 연결 (WebSocket) ──
// REST와 같은 서버·포트(3000)를 같이 쓴다
const server = app.listen(3000, '0.0.0.0', () => console.log('서버 시작!'));
const wss = new WebSocketServer({ server });
const sockets = new Map(); // groupId → Set<ws> (그 동행에 연결된 앱들)

// 한 연결에 JSON 보내기
function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// 에러를 보낸 앱에게만 돌려주기 (앱은 message를 토스트로 띄움)
function sendError(ws, error, message) {
  send(ws, { type: 'error', error, message });
}

// 그 동행에 연결된 모든 앱에게 현재 명단 보내기
function broadcastGroupState(groupId) {
  const group = groups.get(groupId);
  const set = sockets.get(groupId);
  if (!group || !set) return;
  const msg = { type: 'group_state', groupId, vehicles: vehicleNames(group) };
  for (const ws of set) send(ws, msg);
}

// 이 연결을 지금 동행의 알림 대상에서 빼기 (방을 바꾸거나, 나가거나, 끊길 때)
function detach(ws) {
  const set = sockets.get(ws.groupId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) sockets.delete(ws.groupId);
  }
  ws.groupId = null;
  ws.vehicleId = null;
}

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return sendError(ws, 'BAD_JSON', 'JSON 형식이 아닙니다');
  }
  // null, 숫자, 문자열, 배열은 거절 ({ ... } 모양만 받는다)
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return sendError(ws, 'BAD_MESSAGE', '메시지는 { "type": ... } 형태여야 합니다');
  }

  if (msg.type === 'join') {
    const group = groups.get(msg.groupId);
    if (!group || !group.vehicles.has(msg.vehicleId)) {
      return sendError(ws, 'NOT_A_MEMBER', '동행에 참가한 차량이 아닙니다. REST로 먼저 참가하세요');
    }
    detach(ws); // 이미 다른 동행에 등록돼 있으면 먼저 뺀다 → 이전 동행 소식이 안 옴
    ws.groupId = msg.groupId;
    ws.vehicleId = msg.vehicleId;
    if (!sockets.has(ws.groupId)) sockets.set(ws.groupId, new Set());
    sockets.get(ws.groupId).add(ws);
    send(ws, { type: 'group_state', groupId: ws.groupId, vehicles: vehicleNames(group) });
    return;
  }

  if (msg.type === 'leave') {
    detach(ws); // 알림만 끊는다. 동행 명단에서 빼는 건 아님
    return;
  }

  sendError(ws, 'UNKNOWN_TYPE', `모르는 type입니다: ${msg.type}`);
}

wss.on('connection', (ws) => {
  ws.groupId = null;
  ws.vehicleId = null;

  ws.on('message', (raw) => {
    try {
      handleMessage(ws, raw);
    } catch (e) {
      // 예상 못 한 에러가 나도 서버는 계속 돈다
      console.error('[WS 처리 에러]', e);
      sendError(ws, 'SERVER_ERROR', '서버 처리 중 오류가 났습니다');
    }
  });

  // 깨진 프레임 등 연결 자체의 에러. 이 리스너가 없으면 서버 전체가 꺼진다
  ws.on('error', (e) => console.error('[WS 연결 에러]', e.message));

  // 연결이 끊기면 알림 대상에서만 뺀다 (동행에서 탈퇴시키지는 않음)
  ws.on('close', () => detach(ws));
});

wss.on('error', (e) => console.error('[WS 서버 에러]', e.message));
