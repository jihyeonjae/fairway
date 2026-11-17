const path = require('path');
const fs = require('fs');

// ── 설정 읽기 ──
// env/.env 가 있으면 읽는다 (없으면 기본값). 형식은 env/.env.example 참고
// 이미 터미널에서 준 환경변수(SERVER_PORT=4000 node index.js)가 파일보다 우선
const ENV_FILE = path.join(__dirname, '..', 'env', '.env');
if (fs.existsSync(ENV_FILE) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(ENV_FILE); // Node 20.12+ 내장 기능
}
const PORT = Number(process.env.SERVER_PORT) || 3000;

const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const app = express();
app.use(cors());
app.use(express.json());

// ── 메모리 저장소 (서버 끄면 사라짐) ──
const groups = new Map();      // groupId → 동행 정보
const codeToGroup = new Map(); // inviteCode → groupId (코드로 동행 찾기용)
// ID는 무작위로 만든다. 순번(g1, v2)이면 서버를 재시작했을 때 번호가 1부터 다시 시작해서,
// 앱이 저장해 둔 예전 ID가 새로 생긴 다른 차량 ID와 겹쳐 남의 차로 접속될 수 있다
const crypto = require('crypto');
function newId(prefix) {
  return prefix + crypto.randomBytes(6).toString('hex'); // 예: g3f9a1c0b7e2d
}

// 6자리 코드 만들기. 이미 쓰는 코드면 다시 뽑는다
function newInviteCode() {
  let code;
  do {
    code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  } while (codeToGroup.has(code));
  expiredCodes.delete(code); // 예전에 만료된 같은 번호의 안내 기록이 남아 있으면 지운다
  return code;
}

// 이름 정리: 문자열만, 앞뒤 공백 제거, 1~20자 (20자는 가정). 아니면 null
// "2호차"와 "2호차 "를 같은 이름으로 보게 해서 중복 검사가 공백으로 뚫리지 않게 한다
const NAME_MAX = 20;
function cleanName(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length >= 1 && s.length <= NAME_MAX ? s : null;
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 테스트 전용: 메모리에 남은 데이터 개수 (삭제가 실제로 됐는지 확인용). DEBUG_STATS=1일 때만 켜진다
if (process.env.DEBUG_STATS === '1') {
  app.get('/debug/stats', (req, res) => {
    let vehicles = 0; let locations = 0; let hazards = 0;
    for (const g of groups.values()) {
      vehicles += g.vehicles.size;
      for (const v of g.vehicles.values()) if (v.location) locations++;
      hazards += g.hazards ? g.hazards.size : 0;
    }
    res.json({ groups: groups.size, codes: codeToGroup.size, vehicles, locations, hazards, socketGroups: sockets.size, endedGroups: endedGroups.size, expiredCodes: expiredCodes.size });
  });
}

// ── 동행 만들기 ──
app.post('/api/groups', (req, res) => {
  const vehicleName = cleanName(req.body?.vehicleName); // ?. = body가 없어도 에러 없이 undefined
  if (!vehicleName) {
    return res.status(400).json({ error: 'MISSING_VEHICLE_NAME', message: 'vehicleName은 1~20자 문자열이어야 합니다' });
  }

  const groupId = newId('g');
  const vehicleId = newId('v');
  const inviteCode = newInviteCode();

  groups.set(groupId, {
    groupId,
    inviteCode,
    createdAt: Date.now(),          // 30분 만료 계산에 씀 (다음 단계)
    hostVehicleId: vehicleId,       // 만든 차량 = 호스트
    vehicles: new Map([[vehicleId, { vehicleId, vehicleName, status: null }]]), // status: 마지막 차량 상태
  });
  codeToGroup.set(inviteCode, groupId);

  res.json({ groupId, inviteCode, vehicleId });
});

// ── 참가 규칙 (계획서 가정값) ──
// 코드 유효시간 30분 (가정). 테스트 땐  CODE_TTL_MS=2000 node index.js  처럼 짧게
const CODE_TTL_MS = Number(process.env.CODE_TTL_MS) || 30 * 60 * 1000;
const MAX_VEHICLES = 5;             // 동행 최대 5대 (가정)

// 동행 안 차량들의 이름만 뽑아서 배열로: ["1호차", "2호차"]
function vehicleNames(group) {
  return [...group.vehicles.values()].map(v => v.vehicleName);
}

// ── 동행 참가하기 ──
app.post('/api/groups/join', (req, res) => {
  const inviteCode = req.body?.inviteCode;
  const vehicleName = cleanName(req.body?.vehicleName);
  if (!vehicleName) {
    return res.status(400).json({ error: 'MISSING_VEHICLE_NAME', message: 'vehicleName은 1~20자 문자열이어야 합니다' });
  }

  // 코드로 동행 찾기
  const groupId = codeToGroup.get(String(inviteCode));
  // 정리 작업이 코드 찾기 목록에서 지운 만료 코드도 "없는 코드"가 아니라 "만료"로 알려준다
  if (!groupId && expiredCodes.has(String(inviteCode))) {
    return res.status(410).json({ error: 'CODE_EXPIRED', message: '참가 코드 유효시간이 지났습니다' });
  }
  const group = getLiveGroup(groupId);
  if (!group) {
    return res.status(404).json({ error: 'INVALID_CODE', message: '없는 참가 코드입니다' });
  }
  if (Date.now() - group.createdAt > CODE_TTL_MS) {
    return res.status(410).json({ error: 'CODE_EXPIRED', message: '참가 코드 유효시간이 지났습니다' });
  }
  if (group.vehicles.size >= MAX_VEHICLES) {
    return res.status(409).json({ error: 'GROUP_FULL', message: `동행은 최대 ${MAX_VEHICLES}대까지입니다` });
  }
  // 같은 이름이 둘이면 앱 명단에서 구분이 안 된다. 재시작한 앱은 REST 재참가 말고 저장해둔 ID로 WS join만 다시 보낸다
  if (vehicleNames(group).includes(vehicleName)) {
    return res.status(409).json({ error: 'DUPLICATE_NAME', message: '이미 같은 이름의 차량이 있습니다' });
  }

  // 통과하면 참가 목록에 추가
  const vehicleId = newId('v');
  group.vehicles.set(vehicleId, { vehicleId, vehicleName, status: null });

  res.json({ groupId, vehicleId, vehicles: vehicleNames(group) });
  broadcastGroupState(groupId); // 이미 연결된 차량들에게 새 명단 알림
});

// ── 참가 차량 목록 보기 ──
app.get('/api/groups/:groupId', (req, res) => {
  const group = getLiveGroup(req.params.groupId);
  if (!group && endedGroups.has(req.params.groupId)) {
    return res.status(410).json({ error: 'GROUP_ENDED', message: '종료된 동행입니다' });
  }
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
// REST와 같은 서버·포트(SERVER_PORT, 기본 3000)를 같이 쓴다
const server = app.listen(PORT, '0.0.0.0', () => console.log(`서버 시작! 포트 ${PORT}`));
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`포트 ${PORT}을 이미 다른 프로그램이 쓰고 있습니다. 켜져 있는 서버를 끄거나 SERVER_PORT를 바꾸세요`);
  } else {
    console.error('[서버 시작 에러]', e.message);
  }
  process.exit(1);
});
// maxPayload: 메시지 1개 최대 16KB. 기본값(100MB)이면 큰 데이터 한 방에 메모리가 터질 수 있음
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
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

// ── 연습용 차량 상태 (vehicle_status) ──
// 실제 차량 SDK 값이 아니라 버튼·테스트로 보내는 연습용 값이다
const STATUS_MAX_PER_SEC = 20;             // 한 연결이 1초에 20번 넘게 보내면 거절 (도배 방지, 가정)
const WARNING_PATTERN = /^[A-Z0-9_]{1,32}$/; // warning은 "NONE", "TIRE_LOW" 같은 대문자 코드만 (제안)
// 아직 보내지 않은 칸의 기본값. 앱이 항상 두 칸을 다 받도록 서버가 채운다
const DEFAULT_STATUS = { ready: false, warning: 'NONE' };

// data 검사: 문제가 있으면 { error }를, 통과하면 { value }를 돌려준다
// 알려진 칸(ready, warning)만 골라 담는다 → 이상한 칸이 다른 차로 퍼지지 않음
function validateStatus(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'data는 { "ready": true, "warning": "NONE" } 형태여야 합니다' };
  }
  const value = {};
  if ('ready' in data) {
    if (typeof data.ready !== 'boolean') return { error: 'ready는 true 또는 false여야 합니다' };
    value.ready = data.ready;
  }
  if ('warning' in data) {
    if (typeof data.warning !== 'string' || !WARNING_PATTERN.test(data.warning)) {
      return { error: 'warning은 NONE 같은 대문자 코드여야 합니다 (A-Z, 0-9, _ 최대 32자)' };
    }
    value.warning = data.warning;
  }
  if (Object.keys(value).length === 0) return { error: 'ready나 warning 중 하나는 있어야 합니다' };
  return { value };
}

// 같은 동행의 다른 연결들에게만 보내기 (보낸 사람 제외)
function broadcastExcept(groupId, exceptWs, obj) {
  const set = sockets.get(groupId);
  if (!set) return;
  for (const ws of set) if (ws !== exceptWs) send(ws, obj);
}

function statusMessage(groupId, vehicle) {
  return {
    type: 'vehicle_status_updated',
    groupId,
    vehicleId: vehicle.vehicleId,
    vehicleName: vehicle.vehicleName, // 앱은 명단을 이름으로 보여주므로 이름도 같이 보낸다
    data: vehicle.status,
  };
}

function handleVehicleStatus(ws, msg) {
  if (!ws.groupId) {
    return sendError(ws, 'NOT_JOINED', '먼저 join으로 동행에 연결하세요');
  }
  // 누가 보냈는지는 메시지 안의 vehicleId가 아니라 join 때 확인된 값으로 정한다 (다른 차 사칭 방지)
  if (msg.vehicleId !== undefined && msg.vehicleId !== ws.vehicleId) {
    return sendError(ws, 'BAD_STATUS', '다른 차량의 상태는 보낼 수 없습니다');
  }
  // 1초 단위로 보낸 횟수를 센다. 넘치면 버리지 않고 에러로 알린다 (마지막 상태가 조용히 사라지는 것 방지)
  const now = Date.now();
  if (!ws.rate || now - ws.rate.start >= 1000) ws.rate = { start: now, count: 0 };
  if (++ws.rate.count > STATUS_MAX_PER_SEC) {
    return sendError(ws, 'RATE_LIMITED', '상태를 너무 자주 보냈습니다. 잠시 후 다시 보내세요');
  }

  const checked = validateStatus(msg.data);
  if (checked.error) return sendError(ws, 'BAD_STATUS', checked.error);

  const group = getLiveGroup(ws.groupId);
  const vehicle = group && group.vehicles.get(ws.vehicleId);
  if (!vehicle) return sendError(ws, 'NOT_A_MEMBER', '동행에 참가한 차량이 아닙니다');

  // 기본값 → 이전 값 → 이번에 보낸 칸 순서로 덮어쓴다
  // ready만 보내면 warning은 이전 값 유지, 처음이면 기본값 → 항상 ready·warning 둘 다 있음
  const prevWarning = (vehicle.status || DEFAULT_STATUS).warning;
  vehicle.status = { ...DEFAULT_STATUS, ...(vehicle.status || {}), ...checked.value };
  broadcastExcept(ws.groupId, ws, statusMessage(ws.groupId, vehicle));
  onWarningChanged(ws, group, vehicle, prevWarning, vehicle.status.warning, now); // 위험 코드로 바뀌면 위험 생성
}

// ── 차량 위치 (location) ──
// 앱은 1초마다 위치를 보낸다(서 있어도 보냄). 서버는 차마다 마지막 위치만 기억하고 같은 동행에만 전달한다
// 아래 숫자는 전부 가정값. 환경변수로 바꿀 수 있다
const LOCATION_MAX_PER_SEC = Number(process.env.LOCATION_MAX_PER_SEC) || 5;          // 1초 전송이면 5회는 넉넉함. 넘치면 버린다
const LOCATION_MAX_AGE_MS = Number(process.env.LOCATION_MAX_AGE_MS) || 10 * 1000;     // 측정 시각이 10초보다 오래되면 거절 (끊긴 동안 쌓인 옛 위치 방지)
const LOCATION_MAX_FUTURE_MS = Number(process.env.LOCATION_MAX_FUTURE_MS) || 5 * 1000; // 서버 시계보다 5초 넘게 미래면 거절 (기기 시계 오류)
const LOCATION_REPLAY_MAX_MS = Number(process.env.LOCATION_REPLAY_MAX_MS) || 60 * 1000; // join 때 다른 차의 마지막 위치를 몇 초 전 것까지 보내줄지
const MOVING_SPEED_MPS = 1.0; // 이 속도(m/s, 약 3.6km/h) 이상일 때 받은 방향만 "믿을 수 있는 방향"으로 저장

const isNum = (v) => typeof v === 'number' && Number.isFinite(v); // "37.5" 같은 문자열 숫자, NaN, Infinity는 거절

// data 검사: { error } 또는 { value }. 알려진 칸만 골라 담는다
function validateLocation(data, now) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'BAD_LOCATION', message: 'data는 { "lat": 37.5, "lng": 127.0, "timestamp": 1700000000000 } 형태여야 합니다' };
  }
  const { lat, lng, heading, speed, accuracy, timestamp } = data;
  if (!isNum(lat) || lat < -90 || lat > 90) return { error: 'BAD_LOCATION', message: 'lat은 -90~90 숫자여야 합니다' };
  if (!isNum(lng) || lng < -180 || lng > 180) return { error: 'BAD_LOCATION', message: 'lng은 -180~180 숫자여야 합니다' };
  // (0, 0)은 GPS를 못 잡은 앱이 기본값을 그대로 보낸 경우가 대부분이다
  if (lat === 0 && lng === 0) return { error: 'BAD_LOCATION', message: '위치가 (0, 0)입니다. GPS를 잡은 뒤 보내세요' };
  // heading·speed·accuracy는 없을 수 있다(정지 중이면 방향이 없음). 없으면 null로 보낸다
  if (heading != null && (!isNum(heading) || heading < 0 || heading >= 360)) {
    return { error: 'BAD_LOCATION', message: 'heading은 0 이상 360 미만 숫자 또는 null이어야 합니다' };
  }
  if (speed != null && (!isNum(speed) || speed < 0 || speed > 100)) {
    return { error: 'BAD_LOCATION', message: 'speed는 0~100(m/s) 숫자 또는 null이어야 합니다' };
  }
  if (accuracy != null && (!isNum(accuracy) || accuracy < 0)) {
    return { error: 'BAD_LOCATION', message: 'accuracy는 0 이상 숫자(m) 또는 null이어야 합니다' };
  }
  if (!isNum(timestamp)) return { error: 'BAD_LOCATION', message: 'timestamp(측정 시각, 밀리초)가 필요합니다' };
  // 초 단위(10자리)로 보내면 "오래된 위치"로 오해하기 쉬워서 따로 알려준다. 1e12 ms = 2001년
  if (timestamp < 1e12) return { error: 'BAD_LOCATION', message: 'timestamp는 초가 아니라 밀리초여야 합니다 (System.currentTimeMillis / Location.getTime)' };
  if (now - timestamp > LOCATION_MAX_AGE_MS) {
    return { error: 'LOCATION_TOO_OLD', message: `측정한 지 ${LOCATION_MAX_AGE_MS / 1000}초가 넘은 위치입니다` };
  }
  if (timestamp - now > LOCATION_MAX_FUTURE_MS) {
    return { error: 'LOCATION_FROM_FUTURE', message: '측정 시각이 서버 시각보다 미래입니다. 기기 시계를 확인하세요' };
  }
  return {
    value: {
      lat, lng,
      heading: heading ?? null,
      speed: speed ?? null,
      accuracy: accuracy ?? null,
      measuredAt: timestamp, // 앱 기기 시계 기준
      receivedAt: now,       // 서버 시계 기준. "최근 위치인지" 판단은 이 값으로 한다 (기기 시계 차이 영향 없음)
    },
  };
}

function locationMessage(groupId, vehicle) {
  const { lat, lng, heading, speed, accuracy, measuredAt, receivedAt } = vehicle.location;
  return {
    type: 'vehicle_location_updated',
    groupId,
    vehicleId: vehicle.vehicleId,
    vehicleName: vehicle.vehicleName,
    data: { lat, lng, heading, speed, accuracy, measuredAt, receivedAt },
  };
}

function handleLocation(ws, msg) {
  if (!ws.groupId) return sendError(ws, 'NOT_JOINED', '먼저 join으로 동행에 연결하세요');
  if (msg.vehicleId !== undefined && msg.vehicleId !== ws.vehicleId) {
    return sendError(ws, 'BAD_LOCATION', '다른 차량의 위치는 보낼 수 없습니다');
  }
  const now = Date.now();
  // 1초 단위로 센다. 넘치면 저장하지 않고 버리고, 에러는 그 1초 동안 한 번만 보낸다 (에러 도배 방지)
  if (!ws.locRate || now - ws.locRate.start >= 1000) ws.locRate = { start: now, count: 0, warned: false };
  if (++ws.locRate.count > LOCATION_MAX_PER_SEC) {
    if (!ws.locRate.warned) {
      ws.locRate.warned = true;
      sendError(ws, 'RATE_LIMITED', `위치는 1초에 ${LOCATION_MAX_PER_SEC}번까지만 받습니다`);
    }
    return;
  }

  const checked = validateLocation(msg.data, now);
  if (checked.error) return sendError(ws, checked.error, checked.message);

  const group = getLiveGroup(ws.groupId);
  const vehicle = group && group.vehicles.get(ws.vehicleId);
  if (!vehicle) return sendError(ws, 'NOT_A_MEMBER', '동행에 참가한 차량이 아닙니다');

  // 늦게 도착한 옛 위치가 새 위치를 덮어쓰지 않게
  if (vehicle.location && checked.value.measuredAt < vehicle.location.measuredAt) return;

  vehicle.location = checked.value;
  // 움직이는 중에 받은 방향만 따로 기억한다. 정지 중 방향은 0이나 엉뚱한 값일 수 있어서 위험 판정에 쓰지 않는다
  // speed가 없으면 움직이는지 알 수 없지만, 방향이 함께 왔다면 이동 중으로 본다 (가정)
  const v = checked.value;
  if (v.heading !== null && (v.speed === null || v.speed >= MOVING_SPEED_MPS)) {
    vehicle.lastMovingHeading = { heading: v.heading, receivedAt: now };
  }
  broadcastExcept(ws.groupId, ws, locationMessage(ws.groupId, vehicle));
  onLocationUpdated(ws, group, vehicle, now); // 기다리던 위험 생성 + 다가온 위험 경고
}

// ── 위험 감지와 뒤차 경고 (hazard) ──
// 별도 메시지 없이 기존 vehicle_status.warning에서 만든다 (11.17 리더 결정)
// warning이 위험 코드로 "바뀌는 순간" 보낸 차의 최근 위치·방향으로 위험 지점을 하나 만들고,
// 같은 동행에서 그 지점에 다가오는 뒤차에게만 hazard_alert를 1번 보낸다
// 직선거리·방향 기준의 시연용 판정이다. 실제 도로상 앞뒤 관계를 보장하지 않는다
// 아래 숫자는 전부 가정값. 환경변수로 바꿀 수 있다
const HAZARD_CODES = new Set((process.env.HAZARD_CODES || 'ESC_BLINK,HAZARD_TELLTALE').split(',').map(s => s.trim()).filter(Boolean));
const HAZARD_CLEAR_ON_OFF = new Set(['HAZARD_TELLTALE']);     // 경고가 꺼지면 위험도 지운다 (비상등). ESC_BLINK는 노면 위험이라 만료까지 유지
const HAZARD_TTL_MS = Number(process.env.HAZARD_TTL_MS) || 10 * 60 * 1000;          // 위험 유지 10분
const HAZARD_ALERT_RADIUS_M = Number(process.env.HAZARD_ALERT_RADIUS_M) || 1500;    // 1.5km 안에 들어오면 경고 (문서 가정값)
const HAZARD_DEDUP_RADIUS_M = Number(process.env.HAZARD_DEDUP_RADIUS_M) || 100;     // 같은 차·같은 종류가 100m 안에서 또 켜지면 같은 위험으로 본다
const FRESH_LOCATION_MS = Number(process.env.FRESH_LOCATION_MS) || 3000;            // 위험 판정에 쓰는 위치는 서버가 받은 지 3초 이내만
const HAZARD_PENDING_MS = Number(process.env.HAZARD_PENDING_MS) || 3000;            // 위치보다 경고가 먼저 오면 3초까지 위치를 기다린다
const SOURCE_HEADING_MAX_AGE_MS = Number(process.env.SOURCE_HEADING_MAX_AGE_MS) || 5 * 60 * 1000; // 위험 낸 차는 서서 비상등을 켜는 경우가 많아서, 5분 전까지의 이동 방향을 쓴다
const SAME_DIRECTION_DEG = 45;  // 뒤차 진행 방향과 위험 방향 차이가 45° 이내여야 같은 방향
const AHEAD_DEG = 60;           // 뒤차 기준 위험 지점이 앞쪽 ±60° 안에 있어야 "다가오는 중"

const toRad = (d) => d * Math.PI / 180;
// 두 좌표 사이 직선거리(m), 하버사인 공식
function distanceM(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// a에서 b를 바라보는 방위각(0=북, 90=동)
function bearingDeg(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// 두 방향의 차이(0~180)
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

const freshLocation = (vehicle, now) => vehicle.location && now - vehicle.location.receivedAt <= FRESH_LOCATION_MS ? vehicle.location : null;

// 만료된 위험 정리 (조회할 때마다 같이 한다. 별도 타이머가 필요 없음)
function pruneHazards(group, now) {
  if (!group.hazards) group.hazards = new Map();
  for (const [id, hz] of group.hazards) if (now >= hz.expiresAt) group.hazards.delete(id);
  return group.hazards;
}

// 이 차가 이 위험에 대해 경고를 받아야 하는지. 판단에 필요한 값이 없으면 추측하지 않고 false(보류)
function shouldAlert(hz, vehicle, now) {
  if (vehicle.vehicleId === hz.sourceVehicleId || hz.notified.has(vehicle.vehicleId)) return false;
  const loc = freshLocation(vehicle, now);
  if (!loc) return false;                                     // 위치가 없거나 오래됨
  const mh = vehicle.lastMovingHeading;
  if (!mh || now - mh.receivedAt > FRESH_LOCATION_MS) return false; // 지금 움직이는 방향을 모름 (정지 중 포함)
  const dist = distanceM(loc, hz);
  if (dist > HAZARD_ALERT_RADIUS_M) return false;
  if (angleDiff(mh.heading, hz.heading) > SAME_DIRECTION_DEG) return false; // 반대 방향·교차 방향
  if (angleDiff(mh.heading, bearingDeg(loc, hz)) > AHEAD_DEG) return false; // 위험 지점이 앞에 없음 = 이미 지남
  return dist;
}

function alertMessage(groupId, hz, sourceName, dist) {
  return {
    type: 'hazard_alert',
    groupId,
    hazardId: hz.hazardId,
    code: hz.code,
    fromVehicleId: hz.sourceVehicleId,
    fromVehicleName: sourceName,
    lat: hz.lat,
    lng: hz.lng,
    distanceM: Math.round(dist),
    createdAt: hz.createdAt,
    expiresAt: hz.expiresAt,
  };
}

// 같은 동행 차량에게 경고 보내기. onlyVehicleId가 있으면 그 차만 검사 (위치가 갱신된 차)
function deliverAlerts(group, hz, now, onlyVehicleId) {
  const source = group.vehicles.get(hz.sourceVehicleId);
  const set = sockets.get(group.groupId);
  for (const v of group.vehicles.values()) {
    if (onlyVehicleId && v.vehicleId !== onlyVehicleId) continue;
    const dist = shouldAlert(hz, v, now);
    if (dist === false) continue;
    hz.notified.add(v.vehicleId); // 연결이 없어도 표시 → 같은 위험으로 두 번 안 울림 (재접속 포함)
    const msg = alertMessage(group.groupId, hz, source ? source.vehicleName : null, dist);
    if (set) for (const ws of set) if (ws.vehicleId === v.vehicleId) send(ws, msg);
  }
}

// 위험 만들기. 위치·방향이 없으면 만들지 않고 이유를 돌려준다
function createHazard(ws, group, vehicle, code, now) {
  const loc = freshLocation(vehicle, now);
  if (!loc) return { pending: 'NO_RECENT_LOCATION' };
  const mh = vehicle.lastMovingHeading;
  if (!mh || now - mh.receivedAt > SOURCE_HEADING_MAX_AGE_MS) return { dropped: 'NO_HEADING' };

  const hazards = pruneHazards(group, now);
  for (const hz of hazards.values()) {
    if (hz.sourceVehicleId === vehicle.vehicleId && hz.code === code && distanceM(hz, loc) <= HAZARD_DEDUP_RADIUS_M) {
      return { hazard: hz, duplicate: true };
    }
  }
  const hz = {
    hazardId: newId('h'),
    code,
    sourceVehicleId: vehicle.vehicleId,
    lat: loc.lat,
    lng: loc.lng,
    heading: mh.heading,
    createdAt: now,
    expiresAt: now + HAZARD_TTL_MS,
    notified: new Set(),
  };
  hazards.set(hz.hazardId, hz);
  deliverAlerts(group, hz, now);
  return { hazard: hz, duplicate: false };
}

// 보낸 차에게 결과 알려주기 (warning 코드를 잘못 보내 조용히 실패하는 것 방지)
function replyHazardResult(ws, code, result) {
  if (result.hazard) {
    const hz = result.hazard;
    return send(ws, { type: 'hazard_created', hazardId: hz.hazardId, code, lat: hz.lat, lng: hz.lng, heading: hz.heading, duplicate: result.duplicate, expiresAt: hz.expiresAt });
  }
  if (result.pending) return send(ws, { type: 'hazard_pending', code, reason: result.pending, waitMs: HAZARD_PENDING_MS });
  send(ws, { type: 'hazard_not_created', code, reason: result.dropped });
}

// vehicle_status 처리 뒤 호출. warning이 바뀐 순간에만 동작
function onWarningChanged(ws, group, vehicle, prev, next, now) {
  if (prev === next) return;
  // 꺼짐: 비상등류는 위험을 지우고 동행에 알린다
  if (HAZARD_CODES.has(prev) && HAZARD_CLEAR_ON_OFF.has(prev)) {
    const hazards = pruneHazards(group, now);
    for (const [id, hz] of hazards) {
      if (hz.sourceVehicleId === vehicle.vehicleId && hz.code === prev) {
        hazards.delete(id);
        broadcastExcept(group.groupId, null, { type: 'hazard_cleared', groupId: group.groupId, hazardId: id, code: prev });
      }
    }
  }
  if (vehicle.pendingHazard && vehicle.pendingHazard.code !== next) vehicle.pendingHazard = null;
  if (!HAZARD_CODES.has(next)) return;
  const result = createHazard(ws, group, vehicle, next, now);
  if (result.pending) vehicle.pendingHazard = { code: next, until: now + HAZARD_PENDING_MS };
  replyHazardResult(ws, next, result);
}

// handleLocation이 위치를 저장한 뒤 호출
function onLocationUpdated(ws, group, vehicle, now) {
  // 1) 위치를 기다리던 위험이 있으면 지금 만든다
  const p = vehicle.pendingHazard;
  if (p) {
    vehicle.pendingHazard = null;
    const stillOn = vehicle.status && vehicle.status.warning === p.code;
    if (now <= p.until && stillOn) {
      replyHazardResult(ws, p.code, createHazard(ws, group, vehicle, p.code, now));
    } else if (stillOn) {
      send(ws, { type: 'hazard_not_created', code: p.code, reason: 'LOCATION_TIMEOUT' });
    }
  }
  // 2) 이 차가 기존 위험에 다가왔는지 검사
  for (const hz of pruneHazards(group, now).values()) deliverAlerts(group, hz, now, vehicle.vehicleId);
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

// ── 동행 종료와 데이터 삭제 (11.17) ──
// 동행이 끝나면 그 동행의 차량 명단·위치·위험 기록·참가 코드·실시간 연결을 전부 지운다
// 끝난 동행은 groupId와 끝난 시각만 잠깐 남겨서(개인 데이터 없음) 늦게 온 요청에 "종료됨"이라고 정확히 알려준다
// 아래 숫자는 전부 가정값. 테스트 땐 GROUP_TTL_MS=1500 SWEEP_INTERVAL_MS=200 처럼 짧게
const GROUP_TTL_MS = Number(process.env.GROUP_TTL_MS) || 12 * 60 * 60 * 1000;         // 동행은 만든 지 12시간이 지나면 자동 종료
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 60 * 1000;         // 1분마다 정리
const TOMBSTONE_TTL_MS = Number(process.env.TOMBSTONE_TTL_MS) || 24 * 60 * 60 * 1000; // "종료됨"·"만료된 코드" 안내는 24시간 동안만
const CLOSE_GROUP_ENDED = 4001; // 이 close 코드를 받은 앱은 자동 재연결하지 않는다 (4000 REPLACED와 같은 규칙)

const endedGroups = new Map();  // groupId → 끝난 시각 (개인 데이터 없음)
const expiredCodes = new Map(); // inviteCode → 만료 처리한 시각 (codeToGroup에서는 지움)

// 동행 끝내기. 두 번 불려도 안전하다 (이미 없으면 false)
function endGroup(groupId, reason) {
  const group = groups.get(groupId);
  if (!group) return false;
  // 1) 지금 연결된 앱들에게 알리고 연결을 끊는다
  const set = sockets.get(groupId);
  if (set) {
    for (const ws of [...set]) {
      send(ws, { type: 'group_ended', groupId, reason });
      ws.groupId = null; // 이후 이 연결로 늦게 오는 위치·상태는 NOT_JOINED로 거절되고 저장되지 않는다
      ws.vehicleId = null;
      ws.close(CLOSE_GROUP_ENDED, 'group_ended');
    }
    sockets.delete(groupId);
  }
  // 2) 참가 코드 무효화 (코드로 동행 찾기 목록에서 제거)
  if (codeToGroup.get(group.inviteCode) === groupId) codeToGroup.delete(group.inviteCode);
  expiredCodes.delete(group.inviteCode);
  // 3) 동행 삭제. 차량 명단, 각 차의 위치·이동 방향·대기 중 위험, 위험 기록과 "이미 알린 차" 기록이 전부 이 객체 안에 있다
  groups.delete(groupId);
  endedGroups.set(groupId, Date.now());
  console.log(`[동행 종료] ${groupId} (${reason})`);
  return true;
}

// 동행을 꺼낼 때 시간이 지났으면 그 자리에서 끝낸다 (정리 주기를 기다리지 않음)
function getLiveGroup(groupId) {
  const group = groups.get(groupId);
  if (group && Date.now() - group.createdAt >= GROUP_TTL_MS) {
    endGroup(groupId, 'EXPIRED');
    return null;
  }
  return group || null;
}

// 주기 정리: 12시간 지난 동행 종료, 30분 지난 참가 코드 제거, 만료 위험 제거, 오래된 안내 기록 제거
// 한 번에 끝까지 도는 동기 함수라 겹쳐 실행되지 않고, 이미 지운 것을 다시 지워도 문제없다
function sweep() {
  const now = Date.now();
  for (const [groupId, group] of groups) {
    if (now - group.createdAt >= GROUP_TTL_MS) { endGroup(groupId, 'EXPIRED'); continue; }
    if (now - group.createdAt > CODE_TTL_MS && codeToGroup.get(group.inviteCode) === groupId) {
      codeToGroup.delete(group.inviteCode);
      expiredCodes.set(group.inviteCode, now);
    }
    pruneHazards(group, now);
  }
  for (const [id, at] of endedGroups) if (now - at > TOMBSTONE_TTL_MS) endedGroups.delete(id);
  for (const [code, at] of expiredCodes) if (now - at > TOMBSTONE_TTL_MS) expiredCodes.delete(code);
}
setInterval(sweep, SWEEP_INTERVAL_MS).unref(); // unref: 이 타이머 때문에 서버 종료가 막히지 않게

// 호스트가 동행 끝내기 (WS: {"type":"end_group"})
function handleEndGroup(ws) {
  if (!ws.groupId) return sendError(ws, 'NOT_JOINED', '먼저 join으로 동행에 연결하세요');
  const group = getLiveGroup(ws.groupId);
  if (!group) return sendError(ws, 'GROUP_ENDED', '이미 종료된 동행입니다');
  if (group.hostVehicleId !== ws.vehicleId) return sendError(ws, 'NOT_HOST', '동행은 만든 차량(호스트)만 종료할 수 있습니다');
  endGroup(group.groupId, 'HOST_ENDED');
}

// 참가자가 동행에서 나가기 (WS: {"type":"leave_group"}). 기존 leave(알림만 끊기)와 달리 명단에서 빠진다
// 나간 차의 위치·위험 기록도 지운다. 자리가 비므로 GROUP_FULL이 풀리고, 같은 이름으로 다시 참가할 수 있다
function handleLeaveGroup(ws) {
  if (!ws.groupId) return sendError(ws, 'NOT_JOINED', '먼저 join으로 동행에 연결하세요');
  const group = getLiveGroup(ws.groupId);
  if (!group) return sendError(ws, 'GROUP_ENDED', '이미 종료된 동행입니다');
  const vehicleId = ws.vehicleId;
  if (group.hostVehicleId === vehicleId) {
    return sendError(ws, 'HOST_CANNOT_LEAVE', '호스트는 나갈 수 없습니다. 동행 종료(end_group)를 쓰세요');
  }
  group.vehicles.delete(vehicleId); // 이름·상태·위치·이동 방향·대기 중 위험이 함께 지워진다
  for (const [id, hz] of pruneHazards(group, Date.now())) {
    if (hz.sourceVehicleId === vehicleId) {
      group.hazards.delete(id);
      broadcastExcept(group.groupId, null, { type: 'hazard_cleared', groupId: group.groupId, hazardId: id, code: hz.code });
    } else {
      hz.notified.delete(vehicleId);
    }
  }
  // 같은 차량의 연결을 동행에서 뺀다 (보통 1개)
  const set = sockets.get(group.groupId);
  if (set) {
    for (const other of [...set]) {
      if (other.vehicleId === vehicleId) { send(other, { type: 'left_group', groupId: group.groupId }); detach(other); }
    }
  }
  broadcastGroupState(group.groupId);
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
    const group = getLiveGroup(msg.groupId);
    // 앱이 저장해 둔 ID로 다시 들어왔는데 동행이 끝났으면 GROUP_ENDED → 앱은 저장값을 지우고 첫 화면으로
    if (!group && endedGroups.has(msg.groupId)) {
      return sendError(ws, 'GROUP_ENDED', '종료된 동행입니다');
    }
    if (!group || !group.vehicles.has(msg.vehicleId)) {
      return sendError(ws, 'NOT_A_MEMBER', '동행에 참가한 차량이 아닙니다. REST로 먼저 참가하세요');
    }
    // 같은 차량의 예전 연결이 남아 있으면 정리 (앱 재시작·재접속·중복 접속)
    // close 코드 4000을 받은 앱은 자동 재연결하면 안 된다 (두 연결이 서로 끊는 무한 반복 방지)
    const oldSet = sockets.get(msg.groupId);
    if (oldSet) {
      for (const other of oldSet) {
        if (other !== ws && other.vehicleId === msg.vehicleId) {
          sendError(other, 'REPLACED', '같은 차량이 다른 곳에서 연결되어 이 연결은 끊습니다');
          detach(other);
          other.close(4000, 'replaced');
        }
      }
    }
    detach(ws); // 이미 다른 동행에 등록돼 있으면 먼저 뺀다 → 이전 동행 소식이 안 옴
    ws.groupId = msg.groupId;
    ws.vehicleId = msg.vehicleId;
    if (!sockets.has(ws.groupId)) sockets.set(ws.groupId, new Set());
    sockets.get(ws.groupId).add(ws);
    send(ws, { type: 'group_state', groupId: ws.groupId, vehicles: vehicleNames(group) });
    // 늦게 들어온 차도 다른 차들의 마지막 상태를 바로 알 수 있게
    for (const v of group.vehicles.values()) {
      if (v.vehicleId !== ws.vehicleId && v.status) send(ws, statusMessage(ws.groupId, v));
    }
    // 다른 차들의 마지막 위치도 보낸다. 너무 오래된 위치(기본 60초)는 지도에 엉뚱하게 찍히므로 보내지 않는다
    // 앱은 data.receivedAt으로 몇 초 전 위치인지 표시할 수 있다
    const now = Date.now();
    for (const v of group.vehicles.values()) {
      if (v.vehicleId !== ws.vehicleId && v.location && now - v.location.receivedAt <= LOCATION_REPLAY_MAX_MS) {
        send(ws, locationMessage(ws.groupId, v));
      }
    }
    return;
  }

  if (msg.type === 'vehicle_status') {
    return handleVehicleStatus(ws, msg);
  }

  if (msg.type === 'location') {
    return handleLocation(ws, msg);
  }

  if (msg.type === 'end_group') {
    return handleEndGroup(ws);
  }

  if (msg.type === 'leave_group') {
    return handleLeaveGroup(ws);
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
