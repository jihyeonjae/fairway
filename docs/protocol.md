# 앱 ↔ 서버 메시지 규격 (1차)

출처: 팀장 작성 「11.14 계획」(2026-11-14). 이전 규격(설계 v3 기반 `/sessions`)을 대체한다.
모든 메시지는 JSON. "가정" = 출처 없는 초기값. "제안" = 계획서에 없어서 임시로 정한 값, 팀 확정 필요.

## REST
기본 주소: `http://<서버 IP>:3000` (에뮬레이터에선 localhost 대신 서버 PC IP. Pleos 에뮬레이터 접속 주소는 확인 필요)

| 메서드 · 경로 | 요청 | 응답 |
| --- | --- | --- |
| GET /health | - | `{"status":"ok"}` |
| POST /api/groups | `{"vehicleName":"1호차"}` | `{"groupId":"g1","inviteCode":"384271","vehicleId":"v1"}` |
| POST /api/groups/join | `{"inviteCode":"384271","vehicleName":"2호차"}` | `{"groupId":"g1","vehicleId":"v2","vehicles":["1호차","2호차"]}` |
| GET /api/groups/:groupId | - | `{"groupId":"g1","vehicles":["1호차","2호차"]}` (제안) |

- inviteCode: 무작위 6자리 숫자. 사용 중인 코드와 겹치면 다시 뽑는다. **문자열**로 주고받는다 (`"012345"`처럼 0으로 시작할 수 있어 숫자로 바꾸면 앞자리 0이 사라짐).
- 동행을 만든 차량이 호스트이며 참가 목록에 바로 들어간다.
- 참가 거절 조건
  - 없는 코드
  - 만료된 코드: 발급 후 30분 (가정)
  - 인원 초과: 최대 5대 (가정)
- 거절 응답 형식 (제안): HTTP 4xx + `{"error":"<코드>","message":"<설명>"}`
  - 404 `INVALID_CODE` / 410 `CODE_EXPIRED` / 409 `GROUP_FULL`
  - 400 `MISSING_VEHICLE_NAME`: 만들기·참가 요청에 vehicleName이 없을 때 (제안)
  - 404 `GROUP_NOT_FOUND`: GET /api/groups/:groupId 에서 없는 groupId (제안)

## WebSocket
접속 주소 (제안): `ws://<서버 IP>:3000` — REST와 같은 서버·포트
공통 형식: `{"type":"<타입>", ...}`

| 방향 | type | 필드 | 보내는 때 |
| --- | --- | --- | --- |
| 앱→서버 | `join` | groupId, vehicleId | 연결 직후. 실시간 알림 등록용이며 동행 참가 자체는 REST join이 담당 |
| 서버→앱 | `group_state` | vehicles | 참가 차량 목록이 바뀔 때 해당 동행 연결 전체에 |
| 앱→서버 | `vehicle_status` | vehicleId, data `{ready, warning}` | 상태 변경 시 |
| 서버→앱 | `vehicle_status_updated` | vehicleId, data `{ready, warning}` | 다른 차량이 vehicle_status를 보냈을 때 같은 동행에 |

- 1차의 `ready`/`warning`은 **연습용 값**이다 (예: `ready:true`, `warning:"NONE"`). 차량 SDK에서 읽은 값이 아니다.
- 연결이 끊겨도 동행에서 바로 빼지 않는다.

## 서버 저장
1차는 서버 메모리(Map)에 저장. 서버를 끄면 사라진다. DB·배포는 1차 범위 밖.
- `Group { groupId, inviteCode, createdAt, hostVehicleId, vehicles: Map<vehicleId, {vehicleId, vehicleName, status}> }`
- `inviteCode → groupId` 인덱스, `groupId → Set<WebSocket>` 연결 목록

---

## 다음 단계 (기존 설계 v3, 미확정)
아래는 이전 규격에 있던 위험 공유 기능이다. 1차 범위 밖이며, 붙일 때 키 이름은 위 규격(`type`, groupId/vehicleId)에 맞춰 다시 정한다.

| 방향 | 이름 | 필드 | 보내는 때 |
| --- | --- | --- | --- |
| 앱→서버 | `location` | lat, lng, heading, src(`"navi"`/`"demo"`) | 위치 변경 시. navi 최소 2초, demo 0.5초 간격(가정) |
| 앱→서버 | `hazard` | kind(`"HAZARD_LIGHT"`/`"SLIP"`), lat, lng, heading, locAgeMs, durationMs | 판정 규칙 통과 시 1회 |
| 앱→서버 | `capability` | hazardLight: bool, esc: bool | 연결 직후 1회 |
| 앱→서버 | `alert_ack` | hazardId | 음성을 읽은 뒤 |
| 서버→앱 | `hazard_alert` | hazardId, kind, distanceM, fromVehicle, count | 매칭 조건 만족 시 수신차에 1회 |
| 서버→앱 | `demo_location` | lat, lng, heading | 시연 모드 스크립트가 차량을 움직일 때. 0.5초 간격(가정) |
| 서버→앱 | `session_end` | reason | 동행 종료 |
| 서버→앱 | `error` | code, message | 잘못된 메시지 |

- `Hazard { id, kind, lat, lng, heading, firstTs, lastTs, fromVehicle, count }`
- 수신차가 alert_ack를 안 보내도 보낸 시점에 alerted에 넣는다 (재연결 시 중복 경고 방지).
