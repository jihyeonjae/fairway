# 앱 ↔ 서버 메시지 규격 (1차)

출처: 동행안전 구현 설계 1차 범위 v3, 3장.
모든 메시지는 JSON. 시각은 epoch ms, 좌표는 WGS84 소수점 도, 방향은 북쪽 기준 0~359도.
"가정" = 출처 없는 초기값.

## REST
| 메서드 · 경로 | 요청 | 응답 |
| --- | --- | --- |
| POST /sessions | `{}` | `{sessionId, code}` |
| POST /sessions/{code}/join | `{}` | `{sessionId, carNo, token}` — carNo는 "1호차"부터 자동 부여 |
| POST /sessions/{id}/leave | `{token}` | 204 |

1차는 서버가 켜질 때 고정 코드 `DEMO01` 세션을 하나 만든다. 초대 코드 UI는 2차.

## WebSocket
접속: `ws://<host>/ws?token=…`
공통 형식: `{"t": "<타입>", "ts": 1731050000000, ...}`

| 방향 | t | 필드 | 보내는 때 |
| --- | --- | --- | --- |
| 앱→서버 | `location` | lat, lng, heading, src(`"navi"`/`"demo"`) | 위치 변경 시. navi 최소 2초, demo 0.5초 간격(가정) |
| 앱→서버 | `hazard` | kind(`"HAZARD_LIGHT"`/`"SLIP"`), lat, lng, heading, locAgeMs, durationMs | 판정 규칙 통과 시 1회 |
| 앱→서버 | `capability` | hazardLight: bool, esc: bool | 연결 직후 1회 |
| 앱→서버 | `alert_ack` | hazardId | 음성을 읽은 뒤 |
| 서버→앱 | `hazard_alert` | hazardId, kind, distanceM, fromCarNo, count | 매칭 조건 만족 시 수신차에 1회 |
| 서버→앱 | `demo_location` | lat, lng, heading | 시연 모드에서 스크립트가 차량을 움직일 때. 0.5초 간격(가정) |
| 서버→앱 | `session_end` | reason | 세션 종료 |
| 서버→앱 | `error` | code, message | 잘못된 메시지 |

## 서버 메모리 모델
- `Session { id, code, createdAt, cars: Map<carNo, Car>, hazards: Hazard[] }`
- `Car { carNo, token, lastLocation, capability, alerted: Set }`
- `Hazard { id, kind, lat, lng, heading, firstTs, lastTs, fromCarNo, count }`

수신차가 alert_ack를 안 보내도 alerted에는 보낸 시점에 넣는다 (재연결 시 중복 경고 방지).
