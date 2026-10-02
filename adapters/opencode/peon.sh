#!/bin/bash
# peon-ping wrapper for OpenCode on Windows (Git Bash)
# Pipes JSON from stdin to peon.ps1 via -File flag (which supports stdin)
#
# This adapter is called by the OpenCode TypeScript plugin when events fire.
# It bridges the gap between the Unix-style peon.sh expected by the plugin
# and the Windows-native peon.ps1.

PEON_PS1=""$HOME/.claude/hooks/peon-ping/peon.ps1""

# If arguments provided (CLI mode), pass directly to PowerShell
if [ $# -gt 0 ]; then
    exec powershell.exe -NoProfile -NonInteractive -Command "& '$PEON_PS1' $@"
    exit $?
fi

# Hook mode: read JSON from stdin, pipe to peon.ps1
JSON=$(cat)
if [ -z "$JSON" ]; then
    exit 0
fi

# Pipe JSON to peon.ps1 via -File (supports stdin redirection)
echo "$JSON" | powershell.exe -NoProfile -NonInteractive -File "$PEON_PS1" 2>/dev/null
exit 0
