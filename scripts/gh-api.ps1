# Calls the GitHub API with the sign-in git already has on this PC. The token is never printed or saved.
param([string]$Method = 'GET', [string]$Path, [string]$Body = '', [string]$Upload = '', [string]$ContentType = 'application/json')
$cred = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
$token = ($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
if (-not $token) { Write-Output 'NO_CREDENTIAL'; exit 2 }
$h = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28'; 'User-Agent' = 'murmur-release' }
$url = if ($Path -like 'https://*') { $Path } else { "https://api.github.com$Path" }
try {
  if ($Upload) { $r = Invoke-RestMethod -Uri $url -Method POST -Headers $h -ContentType 'application/octet-stream' -InFile $Upload -TimeoutSec 1800 }
  elseif ($Body) { $r = Invoke-RestMethod -Uri $url -Method $Method -Headers $h -ContentType ($ContentType + "; charset=utf-8") -Body ([Text.Encoding]::UTF8.GetBytes($Body)) }
  else { $r = Invoke-RestMethod -Uri $url -Method $Method -Headers $h }
  $r | ConvertTo-Json -Depth 4 -Compress
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Write-Output "HTTP_ERROR $code $($_.ErrorDetails.Message)"
}
