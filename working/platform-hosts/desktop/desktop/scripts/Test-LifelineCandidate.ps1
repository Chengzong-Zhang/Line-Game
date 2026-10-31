param(
  [string]$CandidateDirectory = (Join-Path $PSScriptRoot 'candidate'),
  [string]$OutputRoot = (Join-Path $PSScriptRoot 'results'),
  [ValidateSet('same-host','windows-sandbox')][string]$EnvironmentLabel = 'same-host',
  [switch]$IntegrityOnly
)

# Windows PowerShell 5.1 and built-in .NET only. No Node, Python, browser,
# administrator rights, Steam login, or existing player profile is required.
$ErrorActionPreference = 'Stop'
$runDirectory = Join-Path ([IO.Path]::GetFullPath($OutputRoot)) ('check-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($runDirectory) | Out-Null
$profileDirectory = Join-Path $runDirectory 'isolated-profile'
$receipt = [ordered]@{ format='lifeline-standalone-check'; schemaVersion=1; status='RUNNING'; startedAt=[DateTime]::UtcNow.ToString('o'); callerDeclaredEnvironment=$EnvironmentLabel; environmentAttested=$false; os=[Environment]::OSVersion.VersionString; powershell=$PSVersionTable.PSVersion.ToString(); externalRequests=@(); pageErrors=@(); launcherExitCodes=@(); checks=@(); forcedCleanup=$false }
$script:checkProcess = $null
$script:socket = $null
$script:messageId = 0
$phase = 'candidate integrity'

function Assert-Check($condition, [string]$message) { if (-not $condition) { throw $message } }
function Get-Sha256([string]$file) {
  $algorithm=[Security.Cryptography.SHA256]::Create()
  $inputStream=[IO.File]::OpenRead($file)
  try { return [BitConverter]::ToString($algorithm.ComputeHash($inputStream)).Replace('-','').ToLowerInvariant() }
  finally { $inputStream.Dispose(); $algorithm.Dispose() }
}
function Invoke-Cdp([string]$method, $parameters = @{}) {
  $script:messageId++
  $requestId = $script:messageId
  $encoded = [Text.Encoding]::UTF8.GetBytes((@{id=$requestId;method=$method;params=$parameters} | ConvertTo-Json -Depth 20 -Compress))
  $timeout = New-Object Threading.CancellationTokenSource
  $timeout.CancelAfter(30000)
  try {
    $segment = New-Object 'ArraySegment[byte]' -ArgumentList (,$encoded)
    $script:socket.SendAsync($segment,[Net.WebSockets.WebSocketMessageType]::Text,$true,$timeout.Token).GetAwaiter().GetResult() | Out-Null
    while ($true) {
      $stream = New-Object IO.MemoryStream
      try {
        do {
          $buffer = New-Object byte[] 65536
          $received = $script:socket.ReceiveAsync((New-Object 'ArraySegment[byte]' -ArgumentList (,$buffer)),$timeout.Token).GetAwaiter().GetResult()
          Assert-Check ($received.MessageType -ne [Net.WebSockets.WebSocketMessageType]::Close) 'Test browser connection closed'
          $stream.Write($buffer,0,$received.Count)
          Assert-Check ($stream.Length -le 8388608) 'Unexpectedly large browser response'
        } while (-not $received.EndOfMessage)
        $message = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
      } finally { $stream.Dispose() }
      if ($message.method -eq 'Network.requestWillBeSent' -and $message.params.request.url -match '^(https?|wss?):') { $receipt.externalRequests += $message.params.request.url }
      if ($message.method -eq 'Runtime.exceptionThrown') { $receipt.pageErrors += $message.params.exceptionDetails.text }
      if ($message.id -eq $requestId) {
        if ($message.error) { throw ($message.error | ConvertTo-Json -Compress) }
        return $message.result
      }
    }
  } finally { $timeout.Dispose() }
}
function Invoke-Javascript([string]$expression) {
  $response = Invoke-Cdp 'Runtime.evaluate' @{expression=$expression;awaitPromise=$true;returnByValue=$true}
  if ($response.exceptionDetails) { throw ('Page evaluation failed: ' + ($response.exceptionDetails | ConvertTo-Json -Depth 5 -Compress)) }
  return $response.result.value
}
function Wait-Javascript([string]$expression) {
  $deadline=[DateTime]::UtcNow.AddSeconds(25)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Invoke-Javascript $expression) { return }
    Start-Sleep -Milliseconds 100
  }
  throw ('Browser condition timed out: ' + $expression)
}
function Click-Position($position) {
  Assert-Check ($null -ne $position -and $null -ne $position.x -and $null -ne $position.y) 'Missing visible click target'
  Invoke-Cdp 'Input.dispatchMouseEvent' @{type='mousePressed';x=$position.x;y=$position.y;button='left';clickCount=1} | Out-Null
  Invoke-Cdp 'Input.dispatchMouseEvent' @{type='mouseReleased';x=$position.x;y=$position.y;button='left';clickCount=1} | Out-Null
}
function Click-Selector([string]$selector) {
  $encodedSelector=ConvertTo-Json -InputObject $selector -Compress
  Click-Position (Invoke-Javascript "(()=>{const n=document.querySelector($encodedSelector);if(!n)return null;const b=n.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()")
}
function Stop-CheckGame {
  if ($script:socket) {
    try { Invoke-Cdp 'Browser.close' | Out-Null } catch { }
    $script:socket.Dispose(); $script:socket=$null
  }
  if ($script:checkProcess) {
    if (-not $script:checkProcess.WaitForExit(15000)) {
      $receipt.forcedCleanup=$true
      # Only this test's exact launcher and children are stopped.
      & (Join-Path $env:WINDIR 'System32/taskkill.exe') /PID $script:checkProcess.Id /T /F | Out-Null
      Assert-Check ($script:checkProcess.WaitForExit(10000)) 'Test launcher did not stop'
    }
    $exitCode=$script:checkProcess.ExitCode
    $receipt.launcherExitCodes += $exitCode
    $script:checkProcess.Dispose(); $script:checkProcess=$null
    Assert-Check ($exitCode -eq 0) 'Test launcher returned a nonzero exit code'
  }
}
function Start-CheckGame {
  $listener=New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback),0
  $listener.Start(); $port=$listener.LocalEndpoint.Port; $listener.Stop()
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=$executable
  $info.WorkingDirectory=$resolvedCandidate
  $info.Arguments="--remote-debugging-address=127.0.0.1 --remote-debugging-port=$port --disable-background-networking"
  $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
  $info.EnvironmentVariables['LIFELINE_TEST_USER_DATA']=$profileDirectory
  $info.EnvironmentVariables['PATH']="$env:WINDIR;$env:WINDIR\System32;$env:WINDIR\System32\Wbem"
  $info.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE') | Out-Null
  $script:checkProcess=[Diagnostics.Process]::Start($info)
  $deadline=[DateTime]::UtcNow.AddSeconds(60); $target=$null
  while ([DateTime]::UtcNow -lt $deadline) {
    Assert-Check (-not $script:checkProcess.HasExited) 'Test launcher exited before browser startup'
    try {
      $targets=Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 2
      $target=$targets | Where-Object { $_.type -eq 'page' -and $_.url -like 'lifeline://app/*' } | Select-Object -First 1
    } catch { }
    if ($target.webSocketDebuggerUrl) { break }
    Start-Sleep -Milliseconds 200
  }
  Assert-Check ([bool]$target.webSocketDebuggerUrl) 'Packaged application did not expose its isolated test endpoint'
  $uri=[uri]$target.webSocketDebuggerUrl
  Assert-Check ($uri.Scheme -eq 'ws' -and $uri.Host -eq '127.0.0.1' -and $uri.Port -eq $port) 'Unexpected browser endpoint'
  $script:socket=New-Object Net.WebSockets.ClientWebSocket
  $connectTimeout=New-Object Threading.CancellationTokenSource
  $connectTimeout.CancelAfter(10000)
  try { $script:socket.ConnectAsync($uri,$connectTimeout.Token).GetAwaiter().GetResult() | Out-Null } finally { $connectTimeout.Dispose() }
  Invoke-Cdp 'Runtime.enable' | Out-Null
  Invoke-Cdp 'Network.enable' | Out-Null
  Invoke-Cdp 'Page.enable' | Out-Null
  Invoke-Cdp 'Page.reload' | Out-Null
  Wait-Javascript 'Boolean(document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout)'
}

try {
  $resolvedCandidate=[IO.Path]::GetFullPath($CandidateDirectory)
  $manifestPath=Join-Path $resolvedCandidate 'candidate.json'
  Assert-Check ((Get-Item -LiteralPath $manifestPath).Length -le 1048576) 'Candidate manifest is too large'
  $manifest=Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  Assert-Check ($manifest.format -eq 'lifeline-release-candidate' -and $manifest.schemaVersion -eq 1 -and $manifest.status -eq 'SNAPSHOT_COMPLETE') 'Not a completed candidate'
  Assert-Check ($manifest.id -cmatch '^[a-z0-9][a-z0-9.-]{2,70}$' -and $manifest.package.version -cmatch '^[0-9]+\.[0-9]+\.[0-9]+$') 'Invalid candidate identity'
  Assert-Check ($manifest.package.appAsarSha256 -cmatch '^[a-f0-9]{64}$') 'Invalid archive digest'
  Assert-Check ($manifest.portable.path -match '^LIFELINE-[0-9][A-Za-z0-9.-]*-x64-portable\.exe$') 'Unsafe or unsupported executable name'
  Assert-Check ($manifest.portable.sha256 -cmatch '^[a-f0-9]{64}$') 'Invalid executable digest'
  Assert-Check ($manifest.portable.bytes -is [ValueType] -and $manifest.portable.bytes -gt 0 -and [math]::Floor($manifest.portable.bytes) -eq $manifest.portable.bytes) 'Invalid executable size'
  $executable=Join-Path $resolvedCandidate $manifest.portable.path
  $executableItem=Get-Item -LiteralPath $executable
  Assert-Check (-not $executableItem.PSIsContainer -and -not ($executableItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Expected a regular executable file'
  Assert-Check ($executableItem.Length -eq $manifest.portable.bytes) 'Candidate size changed'
  Assert-Check ((Get-Sha256 $executable) -ceq $manifest.portable.sha256) 'Candidate checksum changed'
  $receipt.candidateId=$manifest.id; $receipt.version=$manifest.package.version
  $receipt.portableSha256=$manifest.portable.sha256; $receipt.appAsarSha256=$manifest.package.appAsarSha256
  $receipt.runtimePathMode='Windows system directories only; no Node/Python/browser installation used'
  $receipt.checks += 'Portable size and SHA-256 agree with candidate manifest'
  if ($IntegrityOnly) {
    $receipt.status='INTEGRITY_ONLY_PASS'
  } else {
    $phase='fresh launch and tutorial'
    Start-CheckGame
    if (Invoke-Javascript 'Boolean(document.querySelector(".welcome-overlay"))') { Click-Selector '.welcome-overlay button' }
    foreach ($expectedId in @('L1-connect','L2-close-territory','L3-cut-and-clear','L4-three-point-limit','L5-settle-score')) {
      $level=Invoke-Javascript 'JSON.parse(JSON.stringify(document.querySelector("#app")._vnode.component.proxy.currentTutorialLevel))'
      Assert-Check ($level.id -eq $expectedId) 'Unexpected tutorial sequence'
      if ($level.restriction) {
        $restrictedPoint=ConvertTo-Json -InputObject $level.restriction.point -Compress
        Click-Position (Invoke-Javascript "(()=>{const r=document.querySelector('#app')._vnode.component.proxy.controller.renderer,p=r.getPointPixelCoordinates($restrictedPoint),b=r.canvas.getBoundingClientRect();return{x:b.left+p.x*b.width/r.layout.cssWidth,y:b.top+p.y*b.height/r.layout.cssHeight}})()")
        Wait-Javascript 'document.querySelector("#app")._vnode.component.proxy.tutorialRestrictionObserved'
      }
      if ($level.objective.type -eq 'skip') {
        Click-Selector '.action-button.tutorial-action-target'
      } else {
        $point=ConvertTo-Json -InputObject $level.objective.point -Compress
        Click-Position (Invoke-Javascript "(()=>{const r=document.querySelector('#app')._vnode.component.proxy.controller.renderer,p=r.getPointPixelCoordinates($point),b=r.canvas.getBoundingClientRect();return{x:b.left+p.x*b.width/r.layout.cssWidth,y:b.top+p.y*b.height/r.layout.cssHeight}})()")
      }
      Wait-Javascript 'document.querySelector("#app")._vnode.component.proxy.tutorialSuccess'
      Click-Selector '.tutorial-card-actions > .action-button-primary'
    }
    Wait-Javascript '!document.querySelector("#app")._vnode.component.proxy.tutorialActive'
    $feature=Invoke-Javascript '(async()=>{const v=document.querySelector("#app")._vnode.component.proxy;return{challenges:v.challengeLevels.length,achievements:await window.lifelineDesktop.readAchievements(),steam:await window.lifelineDesktop.getSteamStatus()}})()'
    Assert-Check ($feature.challenges -eq 24 -and $feature.achievements.ok -and $feature.achievements.achievements.Count -eq 5) 'Missing packaged game content'
    Assert-Check (@($feature.achievements.achievements | Where-Object unlocked).Count -eq 1) 'Tutorial achievement did not match actual completed tutorial'
    Assert-Check (-not $feature.steam.configured -and -not $feature.steam.available) 'This check only accepts the declared offline candidate'
    $receipt.checks += 'Five tutorials completed by real pointer events; 24 challenges and five local achievements present; tutorial milestone unlocked'
    $phase='real move and restart'
    if (Invoke-Javascript 'document.querySelector("#app")._vnode.component.proxy.localSetupPending') {
      Click-Position (Invoke-Javascript '(()=>{const n=[...document.querySelectorAll("button")].find(n=>n.textContent.trim()==="\u5f00\u59cb\u5bf9\u5c40");if(!n)return null;const b=n.getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2}})()')
      Wait-Javascript '!document.querySelector("#app")._vnode.component.proxy.localSetupPending'
    }
    Invoke-Javascript 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))' | Out-Null
    $move=Invoke-Javascript '(()=>{const v=document.querySelector("#app")._vnode.component.proxy,r=v.controller.renderer,p=r.getPointPixelCoordinates(v.controller.engine.getSnapshot().legalMoves[0].point),b=r.canvas.getBoundingClientRect();return{x:b.left+p.x*b.width/r.layout.cssWidth,y:b.top+p.y*b.height/r.layout.cssHeight,revision:v.gameState.positionRevision}})()'
    Click-Position $move
    Wait-Javascript "document.querySelector('#app')._vnode.component.proxy.gameState.positionRevision > $($move.revision)"
    $snapshotExpression='JSON.stringify((()=>{const v=document.querySelector("#app")._vnode.component.proxy,e=v.controller.engine,s=e.getSnapshot();return{actions:v.localGameActions,board:s.boardMatrix,edges:s.edges,territories:s.territories,currentPlayer:s.currentPlayer,history:[...e.historyHashes].sort(),tutorial:v.tutorialActive}})())'
    $before=Invoke-Javascript $snapshotExpression
    Assert-Check ((Invoke-Javascript 'document.querySelector("#app")._vnode.component.proxy.localGameActions.length') -gt 0) 'Real move did not enter the saved action history'
    $picture=Invoke-Cdp 'Page.captureScreenshot' @{format='png'}
    [IO.File]::WriteAllBytes((Join-Path $runDirectory 'actual-game.png'),[Convert]::FromBase64String($picture.data))
    Stop-CheckGame
    Start-CheckGame
    Assert-Check ((Invoke-Javascript $snapshotExpression) -ceq $before) 'Restart did not restore the exact match state'
    $receipt.checks += 'Legal point clicked; actual game screenshot captured; normal close and restart retained complete match/history'
    Stop-CheckGame
    Assert-Check ($receipt.externalRequests.Count -eq 0 -and $receipt.pageErrors.Count -eq 0) 'Browser reported external requests or page exceptions'
    Assert-Check (-not $receipt.forcedCleanup) 'Game required forced cleanup'
    $receipt.status='ISOLATED_RUNTIME_PASS'
  }
} catch {
  $receipt.status='FAIL'; $receipt.phase=$phase; $receipt.error=$_.Exception.Message
  if ($script:socket) {
    try {
      $receipt.screenText=Invoke-Javascript 'document.body.innerText.slice(0,2500)'
      $picture=Invoke-Cdp 'Page.captureScreenshot' @{format='png'}
      [IO.File]::WriteAllBytes((Join-Path $runDirectory 'failure.png'),[Convert]::FromBase64String($picture.data))
    } catch { }
  }
} finally {
  try { Stop-CheckGame } catch { $receipt.status='FAIL'; $receipt.cleanupError=$_.Exception.Message }
  $receipt.finishedAt=[DateTime]::UtcNow.ToString('o')
  $receipt.boundary='Isolated-profile runtime only. The environment name is caller-declared, not Sandbox attestation. It does not establish a second physical device, human playtest, Steam integration or signed release.'
  $reportFile=Join-Path $runDirectory 'result.json'
  $receipt | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath $reportFile -Encoding UTF8
  Write-Output ($receipt.status + ' - ' + $reportFile)
}
if ($receipt.status -eq 'FAIL') { exit 1 }
