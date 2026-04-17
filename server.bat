@echo off
cd /d "%~dp0"

set "PORT=3001"
set "BAGS_PORT=3001"
set "TG_TOKEN=8732092516:AAG-C3CneofOGTwgJeBNyH6nzoECkZ7kN7A"
set "TG_CHAT_ID=-5171513471"

node bags.js
