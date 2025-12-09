@echo off
setlocal

:: Solicita a mensagem do commit ao usuário
set /p commit_message="Digite a mensagem do commit: "

:: Adiciona todas as modificações ao stage
echo.
echo === 1/3: Adicionando todos os arquivos (git add .) ===
git add .
if errorlevel 1 goto :git_error

:: Faz o commit com a mensagem fornecida
echo.
echo === 2/3: Realizando o commit (git commit -m "%commit_message%") ===
git commit -m "%commit_message%"
if errorlevel 1 goto :git_error

:: Envia as alterações para o repositório remoto
echo.
echo === 3/3: Enviando para o repositório remoto (git push) ===
:: Nota: Se você precisar especificar a branch (e.g., master, main), use: git push origin sua_branch
git push
if errorlevel 1 goto :git_error

echo.
echo =======================================================
echo Commit e Push concluídos com sucesso! ✨
echo Mensagem: "%commit_message%"
echo =======================================================

goto :end

:git_error
echo.
echo ❌ ERRO: Um comando Git falhou. Verifique as mensagens acima.
echo Certifique-se de que você está no diretório raiz do repositório Git e que o Git está configurado corretamente.
echo (Pressione qualquer tecla para sair)
pause > nul
goto :eof

:end
echo.
echo (Pressione qualquer tecla para sair)
pause > nul
endlocal