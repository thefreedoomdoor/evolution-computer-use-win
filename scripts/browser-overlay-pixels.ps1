<#
  browser-overlay-pixels.ps1 -- task-106 offline pixel comparator (no window, no input, no screen)

  What it is
  --------
  A purely offline image reader: it compares PNG files that are already on disk, region by region,
  and answers one short JSON line (changed pixels, alpha changes, change bbox, region means).
  It never starts, activates or moves a window or a browser; never calls desktop/window/input
  PInvoke (no user32, SendInput, SetCursorPos, ShowWindow); never screenshots or reads the
  screen, because the images must be files this run already wrote and named in the manifest;
  never scales, interpolates, converts colour space or guesses alpha: an unknown format fails the run.

  Why it exists
  ------------
  Node has no PNG decoder here and the helper shot already writes PNG to disk
  (src/desktop/win32.ps1:384), so decoding plus bounded comparison run in a short-lived
  PowerShell process; Node only consumes its JSON. System.Drawing decodes; Add-Type compiles a managed C# loop (no PInvoke).

  Boundaries and refusals (always ok:false + exit 2; never "skip this image and carry on")
  --------------------------------------------------------------
  - manifest files are relative names inside this run artifact root; absolute or escaping paths are refused;
  - image count and byte totals have hard caps (a manifest may only tighten them);
  - the PNG header must be self-consistent: signature / IHDR / bitDepth=8 / colorType in {2,6} / interlace=0,
    and the real size must equal the manifest exactly (no scaling, no tolerance);
  - the decoded .NET pixel format must be Format32bppArgb, Format32bppRgb or Format24bppRgb;
  - both images of a job must agree on size and pixel format;
  - regions must be integers, width and height > 0, fully inside both images (out of bounds is an error, never a crop);
  - the total compared pixel count has a hard cap.

  Output
  ----
  stdout is one JSON line: { ok, schema, images:[...], results:[...], comparedPixels }
  failure: { ok:false, schema, error:{ code, detail } }
  exit codes: 0 success; 2 refused (usable evidence); 1 unexpected exception (error line still attempted).

  Usage
  ----
    powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass \
      -File scripts/browser-overlay-pixels.ps1 -Manifest <absolute manifest path>
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Manifest
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$SCHEMA = 'browser-overlay-pixels/1'

# Hard caps: a manifest limits may only lower these numbers, never raise them.
$HARD_MAX_IMAGES = 24
$HARD_MAX_JOBS = 16
$HARD_MAX_REGIONS = 8
$HARD_MAX_IMAGE_BYTES = 33554432      # 32 MiB
$HARD_MAX_TOTAL_BYTES = 100663296     # 96 MiB
$HARD_MAX_REGION_PIXELS = 4000000     # one region: 4,000,000 pixels
$HARD_MAX_COMPARE_PIXELS = 40000000   # whole manifest: 40,000,000 pixels
$HARD_MAX_IMAGE_SIDE = 20000          # one side of one image: 20,000 pixels
$HARD_MAX_IMAGE_PIXELS = 16000000     # one image: 16,000,000 pixels
$HARD_MAX_DECODED_PIXELS = 64000000   # every decode in this run, added up

function Emit([object]$payload, [int]$code) {
  $json = $payload | ConvertTo-Json -Depth 10 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
  exit $code
}

function Fail([string]$code, [string]$detail, [object]$extra = $null) {
  $error = [ordered]@{ code = $code; detail = $detail }
  if ($null -ne $extra) { $error['extra'] = $extra }
  Emit ([ordered]@{ ok = $false; schema = $SCHEMA; error = $error }) 2
}

function Prop([object]$object, [string]$name) {
  if ($null -eq $object) { return $null }
  $property = $object.PSObject.Properties[$name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function ListOf([object]$value) {
  if ($null -eq $value) { return @() }
  $items = @()
  foreach ($one in @($value)) { if ($null -ne $one) { $items += $one } }
  return $items
}

function IsNumber([object]$value) {
  if ($null -eq $value) { return $false }
  return ($value -is [int]) -or ($value -is [long]) -or ($value -is [double]) -or ($value -is [decimal]) -or ($value -is [int16]) -or ($value -is [byte])
}

function IsWholeNumber([object]$value) {
  if (-not (IsNumber $value)) { return $false }
  $number = [double]$value
  if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) { return $false }
  return $number -eq [Math]::Floor($number)
}

function IsPositiveInteger([object]$value) {
  if (-not (IsWholeNumber $value)) { return $false }
  return ([double]$value -gt 0)
}

function IsNonNegativeInteger([object]$value) {
  if (-not (IsWholeNumber $value)) { return $false }
  return ([double]$value -ge 0)
}

function NumberOr([object]$value, [double]$fallback) {
  if (-not (IsNumber $value)) { return $fallback }
  return [double]$value
}

function Limited([double]$value, [double]$hard) {
  if ($value -lt 0) { return 0 }
  if ($value -gt $hard) { return $hard }
  return [int]$value
}

# ---------------------------------------------------------------------------
# manifest
# ---------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) { Fail 'manifest-missing' $Manifest }
$manifestFull = (Resolve-Path -LiteralPath $Manifest).ProviderPath
try { $raw = [System.IO.File]::ReadAllText($manifestFull) }
catch { Fail 'manifest-unreadable' $_.Exception.Message }
try { $m = $raw | ConvertFrom-Json }
catch { Fail 'manifest-json' $_.Exception.Message }

if ((Prop $m 'schema') -ne $SCHEMA) { Fail 'bad-schema' ([string](Prop $m 'schema')) }

$rootRaw = [string](Prop $m 'root')
if ([string]::IsNullOrWhiteSpace($rootRaw)) { Fail 'bad-root' 'root is empty' }
if (-not [System.IO.Path]::IsPathRooted($rootRaw)) { Fail 'bad-root' 'root must be absolute' }
try { $rootFull = [System.IO.Path]::GetFullPath($rootRaw) }
catch { Fail 'bad-root' $_.Exception.Message }
$sep = [string][System.IO.Path]::DirectorySeparatorChar
if (-not $rootFull.EndsWith($sep)) { $rootFull = $rootFull + $sep }
if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) { Fail 'bad-root' 'root is not an existing directory' }

$limits = Prop $m 'limits'
$maxImages = Limited (NumberOr (Prop $limits 'maxImages') $HARD_MAX_IMAGES) $HARD_MAX_IMAGES
$maxJobs = Limited (NumberOr (Prop $limits 'maxJobs') $HARD_MAX_JOBS) $HARD_MAX_JOBS
$maxRegions = Limited (NumberOr (Prop $limits 'maxRegions') $HARD_MAX_REGIONS) $HARD_MAX_REGIONS
$maxImageBytes = Limited (NumberOr (Prop $limits 'maxImageBytes') $HARD_MAX_IMAGE_BYTES) $HARD_MAX_IMAGE_BYTES
$maxTotalBytes = Limited (NumberOr (Prop $limits 'maxTotalBytes') $HARD_MAX_TOTAL_BYTES) $HARD_MAX_TOTAL_BYTES
$maxRegionPixels = Limited (NumberOr (Prop $limits 'maxRegionPixels') $HARD_MAX_REGION_PIXELS) $HARD_MAX_REGION_PIXELS
$maxComparePixels = Limited (NumberOr (Prop $limits 'maxComparePixels') $HARD_MAX_COMPARE_PIXELS) $HARD_MAX_COMPARE_PIXELS
$maxImageSide = Limited (NumberOr (Prop $limits 'maxImageSide') $HARD_MAX_IMAGE_SIDE) $HARD_MAX_IMAGE_SIDE
$maxImagePixels = Limited (NumberOr (Prop $limits 'maxImagePixels') $HARD_MAX_IMAGE_PIXELS) $HARD_MAX_IMAGE_PIXELS
$maxDecodedPixels = Limited (NumberOr (Prop $limits 'maxDecodedPixels') $HARD_MAX_DECODED_PIXELS) $HARD_MAX_DECODED_PIXELS

# ---------------------------------------------------------------------------
# Managed comparator (no PInvoke; only the three non-premultiplied formats are accepted)
# ---------------------------------------------------------------------------

$csharp = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.IO;

public static class OverlayPixels
{
    // Returns { width, height, bitDepth, colorType, interlace }; negative means a bad PNG header:
    // -1 header shorter than 33 bytes, -2 bad signature, -3 not IHDR.
    public static int[] Header(string path)
    {
        using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            byte[] head = new byte[33];
            int read = 0;
            while (read < head.Length)
            {
                int got = stream.Read(head, read, head.Length - read);
                if (got <= 0) { break; }
                read += got;
            }
            if (read < head.Length) { return new int[] { -1 }; }
            byte[] signature = new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 };
            for (int i = 0; i < 8; i++) { if (head[i] != signature[i]) { return new int[] { -2 }; } }
            if (head[12] != 73 || head[13] != 72 || head[14] != 68 || head[15] != 82) { return new int[] { -3 }; }
            int width = (head[16] << 24) | (head[17] << 16) | (head[18] << 8) | head[19];
            int height = (head[20] << 24) | (head[21] << 16) | (head[22] << 8) | head[23];
            return new int[] { width, height, (int)head[24], (int)head[25], (int)head[28] };
        }
    }

    public static string FormatOf(string path)
    {
        using (Bitmap bitmap = new Bitmap(path)) { return bitmap.PixelFormat.ToString(); }
    }

    private static bool BytesPerPixel(PixelFormat format, out int bytes)
    {
        bytes = 0;
        if (format == PixelFormat.Format32bppArgb) { bytes = 4; return true; }
        if (format == PixelFormat.Format32bppRgb) { bytes = 4; return true; }
        if (format == PixelFormat.Format24bppRgb) { bytes = 3; return true; }
        return false;
    }

    private static void CopyRow(BitmapData data, int row, byte[] target)
    {
        int stride = Math.Abs(data.Stride);
        long offset = data.Scan0.ToInt64() + (long)row * (long)data.Stride;
        Marshal.Copy(new IntPtr(offset), target, 0, stride);
    }

    // status: 0 ok, 1 region out of bounds, 2 sizes differ, 3 pixel formats differ, 4 unsupported format.
    // Remaining slots: 1 changed, 2 alphaChanged, 3 total, 4..7 bbox (x,y,w,h; -1/-1/0/0 when unchanged),
    //                 8..10 meanA(r,g,b), 11..13 meanB(r,g,b). bbox uses absolute image coordinates.
    public static double[] CompareRegion(string aPath, string bPath, int x, int y, int width, int height)
    {
        double[] result = new double[14];
        Bitmap a = null;
        Bitmap b = null;
        BitmapData aData = null;
        BitmapData bData = null;
        try
        {
            a = new Bitmap(aPath);
            b = new Bitmap(bPath);
            if (a.Width != b.Width || a.Height != b.Height) { result[0] = 2; return result; }
            if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > a.Width || y + height > a.Height)
            {
                result[0] = 1;
                return result;
            }
            if (a.PixelFormat != b.PixelFormat) { result[0] = 3; return result; }
            int bpp;
            if (!BytesPerPixel(a.PixelFormat, out bpp)) { result[0] = 4; return result; }

            Rectangle rect = new Rectangle(x, y, width, height);
            aData = a.LockBits(rect, ImageLockMode.ReadOnly, a.PixelFormat);
            bData = b.LockBits(rect, ImageLockMode.ReadOnly, b.PixelFormat);
            byte[] rowA = new byte[Math.Abs(aData.Stride)];
            byte[] rowB = new byte[Math.Abs(bData.Stride)];

            long changed = 0;
            long alphaChanged = 0;
            int minX = int.MaxValue;
            int minY = int.MaxValue;
            int maxX = int.MinValue;
            int maxY = int.MinValue;
            long sumAr = 0, sumAg = 0, sumAb = 0, sumBr = 0, sumBg = 0, sumBb = 0;

            for (int row = 0; row < height; row++)
            {
                CopyRow(aData, row, rowA);
                CopyRow(bData, row, rowB);
                for (int column = 0; column < width; column++)
                {
                    int at = column * bpp;
                    int bB = rowB[at], bG = rowB[at + 1], bR = rowB[at + 2];
                    sumBr += bB; sumBg += bG; sumBb += bR;
                    sumAr += rowA[at]; sumAg += rowA[at + 1]; sumAb += rowA[at + 2];
                    bool differs = rowA[at] != bB || rowA[at + 1] != bG || rowA[at + 2] != bR;
                    if (differs)
                    {
                        changed++;
                        if (column < minX) { minX = column; }
                        if (column > maxX) { maxX = column; }
                        if (row < minY) { minY = row; }
                        if (row > maxY) { maxY = row; }
                    }
                    if (bpp == 4 && rowA[at + 3] != rowB[at + 3]) { alphaChanged++; }
                }
            }

            long total = (long)width * (long)height;
            result[0] = 0;
            result[1] = changed;
            result[2] = alphaChanged;
            result[3] = total;
            if (changed > 0)
            {
                result[4] = minX + x;
                result[5] = minY + y;
                result[6] = maxX - minX + 1;
                result[7] = maxY - minY + 1;
            }
            else
            {
                result[4] = -1; result[5] = -1; result[6] = 0; result[7] = 0;
            }
            result[8] = (double)sumAr / total;
            result[9] = (double)sumAg / total;
            result[10] = (double)sumAb / total;
            result[11] = (double)sumBr / total;
            result[12] = (double)sumBg / total;
            result[13] = (double)sumBb / total;
            return result;
        }
        finally
        {
            if (aData != null) { try { a.UnlockBits(aData); } catch { } }
            if (bData != null) { try { b.UnlockBits(bData); } catch { } }
            if (b != null) { b.Dispose(); }
            if (a != null) { a.Dispose(); }
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $csharp -Language CSharp -ReferencedAssemblies 'System.Drawing' -ErrorAction Stop
}
catch {
  Fail 'decoder-compile' $_.Exception.Message
}

# ---------------------------------------------------------------------------
# images
# ---------------------------------------------------------------------------

$images = @(ListOf (Prop $m 'images'))
if ($images.Count -eq 0) { Fail 'bad-images' 'images must be a non-empty array' }
if ($images.Count -gt $maxImages) { Fail 'too-many-images' ([string]$images.Count) }

$imageById = @{}
$totalBytes = [long]0
# Decoded pixels so far: every FormatOf load and both decodes inside each comparison
# are counted, so a manifest of small images compared many times cannot run away either.
$decodedPixels = [long]0
$imageRows = @()

foreach ($image in $images) {
  $id = [string](Prop $image 'id')
  $file = [string](Prop $image 'file')
  $width = Prop $image 'width'
  $height = Prop $image 'height'

  if ([string]::IsNullOrWhiteSpace($id)) { Fail 'bad-image' 'image without id' }
  if ($imageById.ContainsKey($id)) { Fail 'duplicate-image' $id }
  if ([string]::IsNullOrWhiteSpace($file)) { Fail 'bad-image' $id }
  if (-not (IsPositiveInteger $width) -or -not (IsPositiveInteger $height)) { Fail 'bad-image-size' $id }
  if ([System.IO.Path]::IsPathRooted($file)) { Fail 'path-outside-root' $id }

  $full = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($rootFull, $file))
  if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) { Fail 'path-outside-root' $id }
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { Fail 'missing-image' $id }

  $length = [long](Get-Item -LiteralPath $full).Length
  if ($length -le 0) { Fail 'empty-image' $id }
  if ($length -gt $maxImageBytes) { Fail 'image-too-big' $id }
  $totalBytes += $length

  $head = [OverlayPixels]::Header($full)
  if ($head[0] -lt 0) { Fail 'png-header' ([string]$id + ' code ' + [string]$head[0]) }
  if ($head[0] -ne [int]$width -or $head[1] -ne [int]$height) {
    Fail 'dimension-mismatch' ([string]$id + ' png=' + [string]$head[0] + 'x' + [string]$head[1] + ' declared=' + [string]([int]$width) + 'x' + [string]([int]$height))
  }
  if ($head[2] -ne 8) { Fail 'unsupported-png' ([string]$id + ' bitDepth ' + [string]$head[2]) }
  if ($head[3] -ne 2 -and $head[3] -ne 6) { Fail 'unsupported-png' ([string]$id + ' colorType ' + [string]$head[3]) }
  if ($head[4] -ne 0) { Fail 'unsupported-png' ([string]$id + ' interlace ' + [string]$head[4]) }

  # Size caps before decoding: Header only reads 33 bytes and the width/height are the
  # PNG's own claim, so they have to be refused first; otherwise a 60000x60000 header
  # makes the decode below actually ask for that memory.
  if ([int]$head[0] -gt $maxImageSide -or [int]$head[1] -gt $maxImageSide) {
    Fail 'image-side-too-big' ([string]$id + ' ' + [string]$head[0] + 'x' + [string]$head[1])
  }
  $pixels = [long]$head[0] * [long]$head[1]
  if ($pixels -gt $maxImagePixels) { Fail 'image-pixels-too-big' ([string]$id + ' ' + [string]$pixels) }
  $decodedPixels += $pixels
  if ($decodedPixels -gt $maxDecodedPixels) { Fail 'decoded-pixels-too-big' ([string]$decodedPixels) }

  $format = [OverlayPixels]::FormatOf($full)
  if ($format -ne 'Format32bppArgb' -and $format -ne 'Format32bppRgb' -and $format -ne 'Format24bppRgb') {
    Fail 'unsupported-format' ([string]$id + ' ' + $format)
  }

  $record = @{
    id = $id
    path = $full
    width = [int]$width
    height = [int]$height
    bytes = $length
    format = $format
    colorType = [int]$head[3]
  }
  $imageById[$id] = $record
  $imageRows += ([ordered]@{
    id = $id
    file = $file
    width = [int]$width
    height = [int]$height
    bytes = $length
    colorType = [int]$head[3]
    pixelFormat = $format
  })
}

if ($totalBytes -gt $maxTotalBytes) { Fail 'total-bytes' ([string]$totalBytes) }

# ---------------------------------------------------------------------------
# Static checks for regions / jobs (one bad entry rejects the whole manifest)
# ---------------------------------------------------------------------------

$regions = @(ListOf (Prop $m 'regions'))
if ($regions.Count -gt $maxRegions) { Fail 'too-many-regions' ([string]$regions.Count) }

$regionByName = @{}
foreach ($region in $regions) {
  $name = [string](Prop $region 'name')
  if ([string]::IsNullOrWhiteSpace($name)) { Fail 'bad-region' 'region without name' }
  if ($regionByName.ContainsKey($name)) { Fail 'duplicate-region' $name }
  $x = Prop $region 'x'
  $y = Prop $region 'y'
  $width = Prop $region 'width'
  $height = Prop $region 'height'
  if (-not (IsNonNegativeInteger $x) -or -not (IsNonNegativeInteger $y)) { Fail 'bad-region' $name }
  if (-not (IsPositiveInteger $width) -or -not (IsPositiveInteger $height)) { Fail 'bad-region' $name }
  if (([double]$width * [double]$height) -gt $maxRegionPixels) { Fail 'region-too-big' $name }
  $regionByName[$name] = @{ name = $name; x = [int]$x; y = [int]$y; width = [int]$width; height = [int]$height }
}

$jobs = @(ListOf (Prop $m 'jobs'))
if ($jobs.Count -eq 0) { Fail 'bad-jobs' 'jobs must be a non-empty array' }
if ($jobs.Count -gt $maxJobs) { Fail 'too-many-jobs' ([string]$jobs.Count) }

$totalComparePixels = [long]0
$jobPlan = @()
$jobIndex = 0

foreach ($job in $jobs) {
  $kind = [string](Prop $job 'kind')
  $a = [string](Prop $job 'a')
  $b = [string](Prop $job 'b')
  if ($kind -ne 'compare' -and $kind -ne 'equal') { Fail 'bad-job' ([string]$jobIndex + ' kind ' + $kind) }
  if (-not $imageById.ContainsKey($a)) { Fail 'unknown-image' ([string]$jobIndex + ' a ' + $a) }
  if (-not $imageById.ContainsKey($b)) { Fail 'unknown-image' ([string]$jobIndex + ' b ' + $b) }
  $imageA = $imageById[$a]
  $imageB = $imageById[$b]
  if ($imageA['width'] -ne $imageB['width'] -or $imageA['height'] -ne $imageB['height']) {
    Fail 'dimension-mismatch' ([string]$jobIndex + ' ' + $a + ' vs ' + $b)
  }

  $names = @(ListOf (Prop $job 'regions'))
  if ($kind -eq 'compare' -and $names.Count -eq 0) { Fail 'bad-job' ([string]$jobIndex + ' compare needs regions') }

  $units = @()
  if ($names.Count -eq 0) {
    $units += @{ name = 'full'; x = 0; y = 0; width = $imageA['width']; height = $imageA['height'] }
  }
  else {
    foreach ($rawName in $names) {
      $name = [string]$rawName
      if (-not $regionByName.ContainsKey($name)) { Fail 'unknown-region' ([string]$jobIndex + ' ' + $name) }
      $region = $regionByName[$name]
      if (($region['x'] + $region['width']) -gt $imageA['width'] -or ($region['y'] + $region['height']) -gt $imageA['height']) {
        Fail 'region-out-of-bounds' ([string]$jobIndex + ' ' + $name)
      }
      $units += $region
    }
  }
  foreach ($unit in $units) { $totalComparePixels += ([long]$unit['width'] * [long]$unit['height']) }

  $jobPlan += @{ index = $jobIndex; kind = $kind; a = $a; b = $b; units = $units }
  $jobIndex += 1
}

if ($totalComparePixels -gt $maxComparePixels) { Fail 'compare-too-big' ([string]$totalComparePixels) }

# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------

function RowOf([hashtable]$unit, [double[]]$numbers) {
  $status = [int]$numbers[0]
  if ($status -eq 1) { Fail 'region-out-of-bounds' $unit['name'] }
  if ($status -eq 2) { Fail 'size-mismatch' $unit['name'] }
  if ($status -eq 3) { Fail 'format-mismatch' $unit['name'] }
  if ($status -eq 4) { Fail 'unsupported-format' $unit['name'] }
  if ($status -ne 0) { Fail 'compare-failed' ($unit['name'] + ' status ' + [string]$status) }

  $changed = [int][Math]::Round($numbers[1])
  $alphaChanged = [int][Math]::Round($numbers[2])
  $total = [int][Math]::Round($numbers[3])
  if ($total -le 0) { Fail 'compare-failed' ($unit['name'] + ' total') }
  if ($changed -lt 0 -or $changed -gt $total) { Fail 'compare-failed' ($unit['name'] + ' changed') }
  if ($alphaChanged -lt 0 -or $alphaChanged -gt $total) { Fail 'compare-failed' ($unit['name'] + ' alphaChanged') }

  $bbox = $null
  if ($changed -gt 0) {
    $bbox = [ordered]@{
      x = [int][Math]::Round($numbers[4])
      y = [int][Math]::Round($numbers[5])
      width = [int][Math]::Round($numbers[6])
      height = [int][Math]::Round($numbers[7])
    }
  }

  return [ordered]@{
    name = $unit['name']
    x = [int]$unit['x']
    y = [int]$unit['y']
    width = [int]$unit['width']
    height = [int]$unit['height']
    changed = $changed
    alphaChanged = $alphaChanged
    total = $total
    bbox = $bbox
    meanA = [ordered]@{
      r = [Math]::Round($numbers[8], 3)
      g = [Math]::Round($numbers[9], 3)
      b = [Math]::Round($numbers[10], 3)
    }
    meanB = [ordered]@{
      r = [Math]::Round($numbers[11], 3)
      g = [Math]::Round($numbers[12], 3)
      b = [Math]::Round($numbers[13], 3)
    }
  }
}

$results = @()
foreach ($plan in $jobPlan) {
  $imageA = $imageById[$plan['a']]
  $imageB = $imageById[$plan['b']]
  $rows = @()
  foreach ($unit in $plan['units']) {
    # CompareRegion decodes both images on every call, so each call is charged again.
    $decodedPixels += ([long]$imageA['width'] * [long]$imageA['height']) + ([long]$imageB['width'] * [long]$imageB['height'])
    if ($decodedPixels -gt $maxDecodedPixels) { Fail 'decoded-pixels-too-big' ([string]$decodedPixels) }
    $numbers = [OverlayPixels]::CompareRegion($imageA['path'], $imageB['path'], [int]$unit['x'], [int]$unit['y'], [int]$unit['width'], [int]$unit['height'])
    $rows += (RowOf $unit $numbers)
  }
  $results += ([ordered]@{
    job = [int]$plan['index']
    kind = [string]$plan['kind']
    a = [string]$plan['a']
    b = [string]$plan['b']
    regions = $rows
  })
}

Emit ([ordered]@{
  ok = $true
  schema = $SCHEMA
  images = $imageRows
  results = $results
  comparedPixels = $totalComparePixels
}) 0
