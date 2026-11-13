# 페어웨이 (Fairway)

차 여러 대가 함께 이동할 때, 각 차가 감지한 위험과 차량 상태를 일행의 다른 차에 자동으로 알려주는 Pleos Connect 앱.

## 실행 방법

### 1. 에뮬레이터 준비 (처음 한 번)
1. Android Studio → More Actions → SDK Manager → SDK Update Sites 탭 → `+`
   - Name: `Pleos Connect System Image`
   - URL: `https://nexus.playground.pleos.ai/repository/raw-prereleases/connect-avd/2.x/crp-sys-img.xml`
2. SDK Platforms 탭 → Show Package Details 체크 → Android API 34 아래 Pleos Connect v2.1.0 시스템 이미지 설치
   - Windows / Intel Mac: `Intel x86_64 Atom System Image`
   - **Apple Silicon Mac (M1~M4): `arm64-v8a` 이미지** (x86_64 이미지는 실행 안 됨)
3. 같은 탭에서 **Android API 37 플랫폼**도 설치 (앱 compileSdk가 37)
4. Virtual Device Manager → `+` → Automotive → Pleos Connect v2.1.0 → Advanced Settings에서 Default boot `Cold`, RAM `4 GB`

### 2. 앱 실행
1. Android Studio에서 **`android/` 폴더**를 연다 (fairway 루트 아님)
2. Gradle Sync 완료까지 대기. Pleos SDK(NaviHelper, Vehicle)는 자동으로 받아짐
3. 실행 대상에서 Pleos Connect v2.1.0 선택 → Run

### 3. 서버 실행
(작성 예정)

## 브랜치 규칙
- `main`: 제출용. 직접 작업하지 않음
- `develop`: 통합 개발 브랜치
- `feature/기능명`: 작업 브랜치. develop에서 만들고, PR은 develop으로 올림
- 커밋 메시지: `feat: …` (기능), `fix: …` (버그), `docs: …` (문서)

```bash
git switch develop
git pull origin develop
git switch -c feature/기능명
# 작업 후
git add .
git commit -m "feat: 기능 설명"
git push -u origin feature/기능명
```

## 테스트 환경
- Pleos Connect Emulator 2.1.0 (API 34)

## APK
`apk/팀명_앱이름_release.apk` (서명된 release 빌드). 서명 keystore는 저장소에 올리지 않음

## 폴더 구조
| 폴더 | 내용 |
| --- | --- |
| android/ | 안드로이드 앱 (Kotlin). 패키지 구성은 android/README.md |
| server/ | Node.js 서버 |
| env/ | 설정 예시 (.env.example). 실제 값은 커밋하지 않음 |
| docs/ | 기획·구성 문서, 앱↔서버 메시지 규격 (protocol.md) |
| apk/ | 제출용 release APK |
