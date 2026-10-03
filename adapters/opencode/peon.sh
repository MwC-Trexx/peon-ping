#!/bin/bash
# peon-ping wrapper for OpenCode on Windows (Git Bash) → peon.ps1

PEON_PS1=""$HOME/.claude/hooks/peon-ping/peon.ps1""

# CLI mode: pass args directly; hook mode: pipe stdin JSON to peon.ps1
if [ $# -gt 0 ]; then
    exec powershell.exe -NoProfile -NonInteractive -Command "& '$PEON_PS1' $@"
fi

# Hook mode: read JSON from stdin, pipe to peon.ps1
JSON=$(cat)
if [ -z "$JSON" ]; then
    exit 0
fi

# Pipe JSON to peon.ps1 via -File (supports stdin redirection)
echo "$JSON" | powershell.exe -NoProfile -NonInteractive -File "$PEON_PS1" 2>/dev/null
exit 0
