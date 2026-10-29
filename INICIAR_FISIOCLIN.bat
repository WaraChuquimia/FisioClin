@echo off
chcp 65001 >nul
title FisioClin - arranque
cd /d "%~dp0"

echo.
echo  ============================================================
echo   FisioClin: se abren dos ventanas. NO las cierres mientras
echo   uses la app en el celular.
echo     1) Servidor Python  (cuenta series y repeticiones)
echo     2) Expo             (el QR para abrir la app)
echo  ============================================================
echo.

if not exist "backend\cv-service\.venv\Scripts\python.exe" (
  echo  [ERROR] No encuentro el entorno de Python en backend\cv-service\.venv
  echo  Crealo una vez con:
  echo     cd backend\cv-service
  echo     python -m venv .venv
  echo     .venv\Scripts\pip install -r requirements.txt
  pause
  exit /b 1
)

rem --- 1) Servidor Python en el puerto 8000, visible para el celular (0.0.0.0)
start "FisioClin - servidor Python" cmd /k "cd /d "%~dp0backend\cv-service" && .venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 8000"

rem --- 2) Expo en la red local (el celular y el PC en el mismo WiFi)
start "FisioClin - Expo" cmd /k "cd /d "%~dp0" && npx expo start -c"

echo  Listo. Espera ~20 s a que el servidor Python diga
echo  "Uvicorn running on http://0.0.0.0:8000" y escanea el QR.
echo.
echo  Si el celular no conecta, comprueba en el navegador del CELULAR:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  echo     http:%%a:8000/salud
)
echo  Tiene que responder {"ok":true,...}
echo.
pause
