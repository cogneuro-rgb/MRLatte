@echo off
REM Starts the backend (FastAPI/uvicorn, :8001) and frontend (CRA dev server, :3000)
REM in their own windows. Close either window (or Ctrl+C in it) to stop that half.
cd /d "%~dp0"

start "MRLatte backend"  cmd /k "cd backend && uvicorn server:app --reload --port 8001"
start "MRLatte frontend" cmd /k "cd frontend && yarn start"
