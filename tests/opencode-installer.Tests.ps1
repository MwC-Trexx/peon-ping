# Native installer behavior. All downloads and files stay inside the test sandbox.
BeforeAll {
    $script:RepoRoot = Split-Path $PSScriptRoot -Parent
}

Describe "OpenCode and Kilo plugin installer discovery" {
    BeforeEach {
        $script:SavedProfile = $env:USERPROFILE
        $script:SavedXdg = $env:XDG_CONFIG_HOME
        $script:SavedAppData = $env:LOCALAPPDATA
        $env:USERPROFILE = Join-Path $TestDrive "home"
        $env:XDG_CONFIG_HOME = $null
        $env:LOCALAPPDATA = Join-Path $TestDrive "unexpected-appdata"
        New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE ".openpeon\packs\peon") | Out-Null
        $script:RequestedUrls = @()
        Mock Invoke-WebRequest {
            param($Uri, $OutFile)
            $script:RequestedUrls += [string]$Uri
            $content = "export default { id: 'fixture-plugin' }"
            if ($OutFile) {
                [System.IO.File]::WriteAllText($OutFile, $content)
            } else {
                [pscustomobject]@{ Content = $content }
            }
        }
    }

    AfterEach {
        $env:USERPROFILE = $script:SavedProfile
        $env:XDG_CONFIG_HOME = $script:SavedXdg
        $env:LOCALAPPDATA = $script:SavedAppData
    }

    It "OpenCode installs under .config even when LOCALAPPDATA exists" {
        & (Join-Path $script:RepoRoot "adapters\opencode.ps1")
        $plugin = Join-Path $env:USERPROFILE ".config\opencode\plugins\peon-ping.ts"
        $plugin | Should -Exist
        Get-Content $plugin -Raw | Should -Match "fixture-plugin"
        Test-Path (Join-Path $env:LOCALAPPDATA "opencode\plugins\peon-ping.ts") | Should -BeFalse
        $script:RequestedUrls | Should -Contain "https://raw.githubusercontent.com/PeonPing/peon-ping/main/adapters/opencode/peon-ping.ts"
    }

    It "OpenCode honors XDG_CONFIG_HOME" {
        $env:XDG_CONFIG_HOME = Join-Path $TestDrive "custom-config"
        & (Join-Path $script:RepoRoot "adapters\opencode.ps1")
        Join-Path $env:XDG_CONFIG_HOME "opencode\plugins\peon-ping.ts" | Should -Exist
        Test-Path (Join-Path $env:USERPROFILE ".config\opencode\plugins\peon-ping.ts") | Should -BeFalse
    }

    It "Kilo downloads its dedicated v1 plugin without OpenCode text patching" {
        & (Join-Path $script:RepoRoot "adapters\kilo.ps1")
        $plugin = Join-Path $env:LOCALAPPDATA "kilo\plugins\peon-ping.ts"
        $plugin | Should -Exist
        (Get-Content $plugin -Raw).Trim() | Should -Be "export default { id: 'fixture-plugin' }"
        $script:RequestedUrls | Should -Contain "https://raw.githubusercontent.com/PeonPing/peon-ping/main/adapters/kilo/peon-ping.ts"
    }
}
