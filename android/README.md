# android

Kotlin, Jetpack Compose, minSdk 28, compileSdk/targetSdk 37.
패키지: `ai.fairway.app`

## 패키지 구성 (제안, 팀장 확인 전)
| 패키지 | 들어갈 것 (구현 설계 v3 기준) |
| --- | --- |
| `feature/hazard` | HazardDetector (비상등·ESC 판정, 순수 Kotlin + 단위 테스트) |
| `feature/voice` | VoiceAnnouncer (TTS + 오디오 포커스) |
| `feature/drive` | DriveService (Foreground Service, 모듈 묶기) |
| `api/vehicle` | VehicleSignalSource (Vehicle SDK 경고등 구독) |
| `api/navi` | LocationSource, NaviLocationSource, 목적지 조회 (NaviHelper) |
| `api/session` | SessionClient, WsSessionClient(OkHttp WebSocket), LocalDemoSession |
| `ui/` | 화면 (Compose), `ui/theme` |

서버와 주고받는 메시지 형식은 `../docs/protocol.md`를 따른다.
