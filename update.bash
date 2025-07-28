#! /bin/bash
pm2 stop jinrou
git reset --hard
git pull
# npm ci
cd front/
# npm ci
npm run production-build
cd ..
SS_ENV=production SS_PACK=1 pm2 start -l ../logs/out.log -e ../logs/err.log -a --name "jinrou" --time app.js --cron-restart="0 4 * * *" --max-memory-restart 700M
