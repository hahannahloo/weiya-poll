@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal

echo.
echo ===== 1/5 安裝 Git、GitHub CLI、Node.js（已安裝的會略過）=====
where git >nul 2>nul || winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
where gh  >nul 2>nul || winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements
where node >nul 2>nul || winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
set "PATH=%PATH%;%ProgramFiles%\Git\cmd;%ProgramFiles%\GitHub CLI;%ProgramFiles%\nodejs;%APPDATA%\npm"
where vercel >nul 2>nul || call npm install -g vercel
where gh >nul 2>nul || goto :fail

echo.
echo ===== 2/5 登入 GitHub（會開瀏覽器，照畫面輸入代碼）=====
gh auth status >nul 2>nul || gh auth login --hostname github.com --git-protocol https --web
gh auth status >nul 2>nul || goto :fail
for /f "delims=" %%i in ('gh api user --jq .login') do set "GHUSER=%%i"
gh auth setup-git >nul 2>nul

echo.
echo ===== 3/5 建立 commit =====
if not exist .git git init -b main
git add .
git -c user.name="%GHUSER%" -c user.email="%GHUSER%@users.noreply.github.com" commit -m "尾牙即時投票網頁" >nul 2>nul

echo.
echo ===== 4/5 上傳到 GitHub =====
git remote get-url origin >nul 2>nul
if errorlevel 1 (
  gh repo create weiya-poll --public --source=. --push || goto :fail
) else (
  git push -u origin main || goto :fail
)

echo.
echo ===== 5/5 部署到 Vercel（第一次會要你登入）=====
call vercel --prod --yes || goto :fail

echo.
echo ===== 完成！=====
echo GitHub：https://github.com/%GHUSER%/weiya-poll
echo 上面 Vercel 給的網址就是你的投票網站，後面加 #screen 是大螢幕、#admin 是主持人。
pause
exit /b 0

:fail
echo.
echo ***** 有一步失敗了。請把這個視窗的畫面截圖給 Claude。*****
echo 如果是剛裝完工具，關掉視窗後再點兩下這個檔案一次通常就會好。
pause
exit /b 1
