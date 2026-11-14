$engines = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue
$3d = ($engines | Where-Object {$_.Name -like "*engtype_3D"} | Measure-Object -Property UtilizationPercentage -Sum).Sum

$adapters = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction SilentlyContinue
$shared = ($adapters | Measure-Object -Property SharedUsage -Sum).Sum
$dedicated = ($adapters | Measure-Object -Property DedicatedUsage -Sum).Sum
$committed = ($adapters | Measure-Object -Property TotalCommitted -Sum).Sum

[PSCustomObject]@{
  utilizationGpu = [math]::Min(100, $3d)
  sharedUsage = $shared
  dedicatedUsage = $dedicated
  totalCommitted = $committed
} | ConvertTo-Json
