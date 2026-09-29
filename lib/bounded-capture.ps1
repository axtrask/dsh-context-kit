param(
  [Parameter(Mandatory = $true)]
  [string] $PlanPath
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Generation = 0
$script:CompletedSteps = 0
$script:CurrentProcess = $null
$script:ExitCode = $null
$script:SpawnError = $null
$script:TerminationReason = $null
$script:StdoutSink = $null
$script:StderrSink = $null
$script:Plan = $null

function Quote-WindowsArgument([string] $Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }

  $builder = New-Object System.Text.StringBuilder
  [void] $builder.Append('"')
  $slashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $slashes += 1
      continue
    }
    if ($character -eq '"') {
      [void] $builder.Append(('\' * (2 * $slashes + 1)))
      [void] $builder.Append('"')
      $slashes = 0
      continue
    }
    if ($slashes -gt 0) {
      [void] $builder.Append(('\' * $slashes))
      $slashes = 0
    }
    [void] $builder.Append($character)
  }
  if ($slashes -gt 0) {
    [void] $builder.Append(('\' * (2 * $slashes)))
  }
  [void] $builder.Append('"')
  return $builder.ToString()
}

function Join-WindowsArguments([object[]] $Arguments) {
  $quoted = @()
  foreach ($argument in $Arguments) {
    $quoted += Quote-WindowsArgument ([string] $argument)
  }
  return [string]::Join(' ', [string[]] $quoted)
}

function New-CaptureSink(
  [string] $HeadPath,
  [string] $TailPath,
  [long] $Capacity,
  [long] $HeadLimit
) {
  $tailLimit = $Capacity - $HeadLimit
  $share = [System.IO.FileShare]::ReadWrite
  $head = New-Object System.IO.FileStream($HeadPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite, $share)
  $tail = New-Object System.IO.FileStream($TailPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite, $share)
  return [pscustomobject]@{
    HeadPath = $HeadPath
    TailPath = $TailPath
    Capacity = $Capacity
    HeadLimit = $HeadLimit
    TailLimit = $tailLimit
    HeadStored = [long] 0
    TailStored = [long] 0
    TailCursor = [long] 0
    Observed = [long] 0
    Wrapped = $false
    Head = $head
    Tail = $tail
  }
}

function Write-CaptureChunk([object] $Sink, [byte[]] $Buffer, [int] $Count) {
  if ($Count -le 0) { return }

  $Sink.Observed = [long] $Sink.Observed + $Count
  $offset = 0
  $remaining = $Count
  $headAvailable = [long] $Sink.HeadLimit - [long] $Sink.HeadStored
  if ($headAvailable -gt 0) {
    $take = [int] [Math]::Min([long] $remaining, $headAvailable)
    $Sink.Head.Position = $Sink.HeadStored
    $Sink.Head.Write($Buffer, $offset, $take)
    $Sink.HeadStored = [long] $Sink.HeadStored + $take
    $offset += $take
    $remaining -= $take
  }

  while ($remaining -gt 0) {
    $room = [long] $Sink.TailLimit - [long] $Sink.TailCursor
    $take = [int] [Math]::Min([long] $remaining, $room)
    $Sink.Tail.Position = $Sink.TailCursor
    $Sink.Tail.Write($Buffer, $offset, $take)
    $Sink.TailCursor = ([long] $Sink.TailCursor + $take) % [long] $Sink.TailLimit
    $Sink.TailStored = [Math]::Min([long] $Sink.TailLimit, [long] $Sink.TailStored + $take)
    $offset += $take
    $remaining -= $take
  }

  $Sink.Wrapped = [long] $Sink.Observed -gt [long] $Sink.Capacity
}

function Flush-CaptureSink([object] $Sink) {
  if ($null -eq $Sink) { return }
  $Sink.Head.Flush()
  $Sink.Tail.Flush()
}

function Complete-CaptureSink([object] $Sink) {
  if ($null -eq $Sink) { return }
  Flush-CaptureSink $Sink

  if ($Sink.Wrapped -and $Sink.TailStored -gt 0) {
    if ($Sink.TailStored -gt [int]::MaxValue) {
      throw "capture tail exceeds the broker's in-memory finalization bound"
    }
    $length = [int] $Sink.TailStored
    $raw = New-Object byte[] $length
    $read = 0
    $Sink.Tail.Position = 0
    while ($read -lt $length) {
      $count = $Sink.Tail.Read($raw, $read, $length - $read)
      if ($count -le 0) { break }
      $read += $count
    }
    if ($read -ne $length) {
      throw "capture tail ended before its recorded length"
    }

    $cursor = [int] $Sink.TailCursor
    $ordered = New-Object byte[] $length
    $first = $length - $cursor
    [System.Buffer]::BlockCopy($raw, $cursor, $ordered, 0, $first)
    if ($cursor -gt 0) {
      [System.Buffer]::BlockCopy($raw, 0, $ordered, $first, $cursor)
    }
    $Sink.Tail.Position = 0
    $Sink.Tail.Write($ordered, 0, $ordered.Length)
    $Sink.Tail.SetLength($ordered.Length)
    $Sink.TailCursor = 0
    $Sink.Wrapped = $false
  } else {
    $Sink.Tail.SetLength([long] $Sink.TailStored)
  }

  $Sink.Head.SetLength([long] $Sink.HeadStored)
  Flush-CaptureSink $Sink
}

function Close-CaptureSink([object] $Sink) {
  if ($null -eq $Sink) { return }
  try { $Sink.Head.Dispose() } catch { }
  try { $Sink.Tail.Dispose() } catch { }
}

function Get-CaptureSnapshot([object] $Sink) {
  if ($null -eq $Sink) {
    return [ordered]@{
      observedBytes = 0
      storedBytes = 0
      droppedBytes = 0
      truncated = $false
      headBytes = 0
      tailBytes = 0
      headLimit = 0
      tailLimit = 0
      tailCursor = 0
      tailWrapped = $false
      headPath = ''
      tailPath = ''
    }
  }
  $stored = [long] $Sink.HeadStored + [long] $Sink.TailStored
  return [ordered]@{
    observedBytes = [long] $Sink.Observed
    storedBytes = $stored
    droppedBytes = [Math]::Max([long] 0, [long] $Sink.Observed - $stored)
    truncated = [long] $Sink.Observed -gt $stored
    headBytes = [long] $Sink.HeadStored
    tailBytes = [long] $Sink.TailStored
    headLimit = [long] $Sink.HeadLimit
    tailLimit = [long] $Sink.TailLimit
    tailCursor = [long] $Sink.TailCursor
    tailWrapped = [bool] $Sink.Wrapped
    headPath = [string] $Sink.HeadPath
    tailPath = [string] $Sink.TailPath
  }
}

function Write-Manifest([string] $State, [bool] $Complete) {
  if ($null -eq $script:Plan) { return }
  Flush-CaptureSink $script:StdoutSink
  Flush-CaptureSink $script:StderrSink
  $script:Generation += 1
  $manifest = [ordered]@{
    version = 1
    state = $State
    complete = $Complete
    generation = $script:Generation
    updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    completedSteps = $script:CompletedSteps
    processId = if ($null -eq $script:CurrentProcess) { $null } else { $script:CurrentProcess.Id }
    exitCode = $script:ExitCode
    spawnError = $script:SpawnError
    terminationReason = $script:TerminationReason
    stdout = Get-CaptureSnapshot $script:StdoutSink
    stderr = Get-CaptureSnapshot $script:StderrSink
  }
  $json = $manifest | ConvertTo-Json -Depth 6 -Compress
  $target = [string] $script:Plan.manifestPath
  $temporary = "$target.tmp.$PID"
  [System.IO.File]::WriteAllText($temporary, $json, $Utf8NoBom)
  if ([System.IO.File]::Exists($target)) {
    try {
      [System.IO.File]::Replace($temporary, $target, $null)
    } catch {
      [System.IO.File]::Delete($target)
      [System.IO.File]::Move($temporary, $target)
    }
  } else {
    [System.IO.File]::Move($temporary, $target)
  }
}

function Read-ControlRequest {
  $path = [string] $script:Plan.controlPath
  if (-not [System.IO.File]::Exists($path)) { return $null }
  try {
    $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    [System.IO.File]::Delete($path)
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return $text | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Stop-ProcessTree([System.Diagnostics.Process] $Process) {
  if ($null -eq $Process) { return }
  try {
    if ($Process.HasExited) { return }
    $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    $arguments = @('/PID', [string] $Process.Id, '/T', '/F')
    & $taskkill @arguments 2>$null | Out-Null
    if (-not $Process.HasExited) { $Process.Kill() }
  } catch {
    try { $Process.Kill() } catch { }
  }
}

function Start-RedirectedProcess([object] $Step) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = [string] $Step.command
  $info.Arguments = Join-WindowsArguments @($Step.args)
  $info.WorkingDirectory = [string] $script:Plan.cwd
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  if (-not $process.Start()) {
    throw "process start returned false for $($info.FileName)"
  }
  return $process
}

try {
  $planText = [System.IO.File]::ReadAllText($PlanPath, [System.Text.Encoding]::UTF8)
  $script:Plan = $planText | ConvertFrom-Json
  $capacity = [long] $script:Plan.captureMaxBytesPerStream
  if ($capacity -lt 2) { throw 'captureMaxBytesPerStream must be at least 2' }
  $headLimit = [long] [Math]::Floor($capacity * 0.75)
  $headLimit = [Math]::Max([long] 1, [Math]::Min($capacity - 1, $headLimit))
  $script:StdoutSink = New-CaptureSink ([string] $script:Plan.stdoutHeadPath) ([string] $script:Plan.stdoutTailPath) $capacity $headLimit
  $script:StderrSink = New-CaptureSink ([string] $script:Plan.stderrHeadPath) ([string] $script:Plan.stderrTailPath) $capacity $headLimit
  Write-Manifest 'provisional' $true

  $lastManifest = [DateTime]::UtcNow
  foreach ($step in @($script:Plan.steps)) {
    try {
      $script:CurrentProcess = Start-RedirectedProcess $step
    } catch {
      $script:SpawnError = $_.Exception.Message
      break
    }

    $stdoutBuffer = New-Object byte[] 65536
    $stderrBuffer = New-Object byte[] 65536
    $stdoutTask = $script:CurrentProcess.StandardOutput.BaseStream.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
    $stderrTask = $script:CurrentProcess.StandardError.BaseStream.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)

    while ($null -ne $stdoutTask -or $null -ne $stderrTask) {
      if ($null -ne $stdoutTask -and $stdoutTask.IsCompleted) {
        $count = $stdoutTask.GetAwaiter().GetResult()
        if ($count -gt 0) {
          Write-CaptureChunk $script:StdoutSink $stdoutBuffer $count
          $stdoutTask = $script:CurrentProcess.StandardOutput.BaseStream.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
        } else {
          $stdoutTask = $null
        }
      }
      if ($null -ne $stderrTask -and $stderrTask.IsCompleted) {
        $count = $stderrTask.GetAwaiter().GetResult()
        if ($count -gt 0) {
          Write-CaptureChunk $script:StderrSink $stderrBuffer $count
          $stderrTask = $script:CurrentProcess.StandardError.BaseStream.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
        } else {
          $stderrTask = $null
        }
      }

      $request = Read-ControlRequest
      if ($null -ne $request) {
        if ([string] $request.action -eq 'terminate') {
          $script:TerminationReason = [string] $request.reason
          Write-Manifest 'provisional' $true
          Stop-ProcessTree $script:CurrentProcess
        }
        Write-Manifest 'provisional' $true
      }

      if (([DateTime]::UtcNow - $lastManifest).TotalMilliseconds -ge 250) {
        Write-Manifest 'provisional' $true
        $lastManifest = [DateTime]::UtcNow
      }
      if (($null -ne $stdoutTask -and -not $stdoutTask.IsCompleted) -and ($null -ne $stderrTask -and -not $stderrTask.IsCompleted)) {
        [System.Threading.Thread]::Sleep(10)
      }
    }

    $script:CurrentProcess.WaitForExit()
    $script:ExitCode = $script:CurrentProcess.ExitCode
    $script:CurrentProcess.Dispose()
    $script:CurrentProcess = $null
    if ($null -ne $script:TerminationReason -or $script:ExitCode -ne 0) { break }
    $script:CompletedSteps += 1
  }

  Complete-CaptureSink $script:StdoutSink
  Complete-CaptureSink $script:StderrSink
  Write-Manifest 'final' $true
} catch {
  $script:SpawnError = $_.Exception.Message
  try { Write-Manifest 'final' $false } catch { }
} finally {
  Close-CaptureSink $script:StdoutSink
  Close-CaptureSink $script:StderrSink
}

exit 0
