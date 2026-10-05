@echo off
cd /d "C:\Users\osanda\Downloads\WB-QualityBOT"

echo =============================== >> qualitybot-log.txt
echo %date% %time% >> qualitybot-log.txt

node qualityV3.js >> qualitybot-log.txt 2>&1

echo Finished %date% %time% >> qualitybot-log.txt