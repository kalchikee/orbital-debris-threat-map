@echo off
echo Starting local server for Orbital Debris Threat Map...
echo.
echo Open this in your browser:  http://localhost:8080
echo Press Ctrl+C to stop the server.
echo.
cd /d "%~dp0"
python -m http.server 8080
pause
