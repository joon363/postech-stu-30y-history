@echo off
chcp 65001 > nul
title 스마트폰 USB 디버깅 연결 (adb reverse)
echo ========================================================
echo    📱 스마트폰 USB 디버깅 포트 포워딩 (adb reverse)
echo ========================================================
echo.
echo 1. 스마트폰과 노트북을 USB 케이블로 연결하세요.
echo 2. 스마트폰 [설정] - [개발자 옵션] - [USB 디버깅]을 켜세요.
echo.
echo 연결된 기기 확인 중...
adb devices
echo.
echo 포트 포워딩을 설정합니다 (tcp:8000)...
adb reverse tcp:8000 tcp:8000
if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================================
    echo  [성공!] 스마트폰 브라우저(크롬/삼성인터넷)에서 접속하세요:
    echo.
    echo       http://localhost:8000/mobile
    echo.
    echo  ※ localhost이므로 보안 경고 없이 카메라가 즉시 허용됩니다!
    echo ========================================================
) else (
    echo.
    echo [안내] 스마트폰 화면에 'USB 디버깅을 항상 허용하시겠습니까?' 팝업이
    echo        뜨면 [허용]을 누르신 후 이 스크립트를 다시 실행해주세요!
)
echo.
pause
