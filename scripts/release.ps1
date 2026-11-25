# Publishes dist\ as a GitHub release: tag v<version>, notes from CHANGELOG.md, the installer, its blockmap and latest.yml.
# Run after `npm run dist`: powershell -ExecutionPolicy Bypass -File scripts\release.ps1
$app = Split-Path $PSScriptRoot -Parent
$api = Join-Path $PSScriptRoot 'gh-api.ps1'
$ver = (Get-Content "$app\package.json" -Raw | ConvertFrom-Json).version
# the release notes: this version's section of CHANGELOG.md
$cl = Get-Content "$app\CHANGELOG.md" -Raw
$sec = [regex]::Match($cl, "(?ms)^## $([regex]::Escape($ver))[^\n]*\n(.*?)(?=^## |\z)").Groups[1].Value.Trim()
$body = @{ tag_name = "v$ver"; target_commitish = 'main'; name = "Murmur $ver"; body = $sec + "`n`n**Install:** download ``Murmur-Setup-$ver.exe`` below and run it. Windows may say ""Windows protected your PC"" because the installer isn't signed: click **More info â†’ Run anyway**. Installed copies from 0.8.0 on update themselves."; draft = $false; prerelease = $false } | ConvertTo-Json
$r = & $api -Method POST -Path /repos/amon28/murmur/releases -Body $body
if ($r -like 'HTTP_ERROR*') { "release failed: $r"; exit 1 }
$rel = $r | ConvertFrom-Json
"release: " + $rel.html_url
foreach ($f in "Murmur-Setup-$ver.exe", "Murmur-Setup-$ver.exe.blockmap", 'latest.yml') {
  $p = Join-Path "$app\dist" $f
  $u = "https://uploads.github.com/repos/amon28/murmur/releases/$($rel.id)/assets?name=$([uri]::EscapeDataString($f))"
  $a = & $api -Path $u -Upload $p
  if ($a -like 'HTTP_ERROR*') { "upload failed $f : $a" } else { $j = $a | ConvertFrom-Json; "uploaded $($j.name) $([math]::Round($j.size/1MB,1)) MB" }
}
