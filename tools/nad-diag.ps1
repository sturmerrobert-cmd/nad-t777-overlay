# =====================================================================
#  Diagnostyka polaczenia z NAD T 748 V2
#  - testuje RS-232 (port COM); NAD T 748 ma stala predkosc 115200,
#    ale dla pewnosci probujemy tez nizsze predkosci
#  - opcjonalnie testuje sterowanie po sieci (TCP, port 23)
#  Nic nie trzeba instalowac. Uruchom przez plik: NAD-diagnostyka.bat
# =====================================================================

$ErrorActionPreference = 'Stop'
$report = New-Object System.Collections.ArrayList

function Say($text, $color = 'Gray') {
    Write-Host $text -ForegroundColor $color
    [void]$report.Add($text)
}

# Komendy zapytan NAD. Klasyczny protokol T748 wymaga opakowania komendy
# znakiem CR z obu stron (\r CMD \r). Urzadzenie odpowiada linia "Main.Power=On".
$QUERIES = @('Main.Model?', 'Main.Power?', 'Main.Volume?')
$BAUDS   = @(115200, 57600, 38400, 19200, 9600)

function Looks-Like-Nad($text) {
    if ([string]::IsNullOrWhiteSpace($text)) { return $false }
    return ($text -match 'Main\.' -or $text -match '=')
}

# --- Test pojedynczej predkosci na danym porcie -----------------------
function Test-SerialBaud($portName, $baud) {
    $sp = $null
    try {
        $sp = New-Object System.IO.Ports.SerialPort $portName, $baud, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
        $sp.ReadTimeout  = 1200
        $sp.WriteTimeout = 1200
        $sp.NewLine = "`r"
        # Niektore przejsciowki USB-RS232 wymagaja podniesienia DTR/RTS.
        $sp.DtrEnable = $true
        $sp.RtsEnable = $true
        $sp.Open()
        Start-Sleep -Milliseconds 150
        $sp.DiscardInBuffer()

        $collected = ''
        foreach ($q in $QUERIES) {
            # Klasyczny protokol NAD (T748): komenda opakowana CR z OBU stron: \r CMD \r
            $sp.Write("`r" + $q + "`r")
            Start-Sleep -Milliseconds 500
            try { $collected += $sp.ReadExisting() } catch {}
        }
        $clean = ($collected -replace "[`r`n]+", ' ').Trim()
        return @{ ok = (Looks-Like-Nad $clean); raw = $clean; error = $null }
    }
    catch {
        return @{ ok = $false; raw = ''; error = $_.Exception.Message }
    }
    finally {
        if ($sp -and $sp.IsOpen) { try { $sp.Close() } catch {} }
        if ($sp) { try { $sp.Dispose() } catch {} }
    }
}

# --- Test petli zwrotnej (loopback): piny 2-3 zwarte na wtyku DB9 -----
#  Sprawdza, czy PC + adapter + kabel w ogole nadaja i odbieraja.
#  Jesli to, co wyslemy, wroci - tor nadawczo-odbiorczy dziala, a wina
#  lezy po stronie NAD-a / protokolu, nie kabla.
function Test-Loopback($portName) {
    $sp = $null
    try {
        $sp = New-Object System.IO.Ports.SerialPort $portName, 115200, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
        $sp.ReadTimeout  = 1000
        $sp.WriteTimeout = 1000
        $sp.DtrEnable = $true
        $sp.RtsEnable = $true
        $sp.Open()
        Start-Sleep -Milliseconds 100
        $sp.DiscardInBuffer()
        $marker = 'LOOPBACK-TEST-12345'
        $sp.Write($marker + "`r")
        Start-Sleep -Milliseconds 300
        $back = ''
        try { $back = $sp.ReadExisting() } catch {}
        $clean = ($back -replace "[`r`n]+", ' ').Trim()
        return @{ ok = ($clean -match 'LOOPBACK-TEST-12345'); raw = $clean; error = $null }
    }
    catch {
        return @{ ok = $false; raw = ''; error = $_.Exception.Message }
    }
    finally {
        if ($sp -and $sp.IsOpen) { try { $sp.Close() } catch {} }
        if ($sp) { try { $sp.Dispose() } catch {} }
    }
}

# --- Test po sieci (TCP:23) ------------------------------------------
function Test-Tcp($ip, $port = 23) {
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($ip, $port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(2000)) {
            return @{ ok = $false; raw = ''; error = "brak polaczenia (timeout) z ${ip}:${port}" }
        }
        $client.EndConnect($iar)
        $stream = $client.GetStream()
        $stream.ReadTimeout = 2000
        $bytes = [System.Text.Encoding]::ASCII.GetBytes("Main.Model?`r")
        $stream.Write($bytes, 0, $bytes.Length)
        Start-Sleep -Milliseconds 600
        $buf = New-Object byte[] 1024
        $n = 0
        try { $n = $stream.Read($buf, 0, $buf.Length) } catch {}
        $resp = if ($n -gt 0) { [System.Text.Encoding]::ASCII.GetString($buf, 0, $n) } else { '' }
        $clean = ($resp -replace "[`r`n]+", ' ').Trim()
        return @{ ok = (Looks-Like-Nad $clean); raw = $clean; error = $null }
    }
    catch {
        return @{ ok = $false; raw = ''; error = $_.Exception.Message }
    }
    finally {
        if ($client) { try { $client.Close() } catch {} }
    }
}

# =====================================================================
#  START
# =====================================================================
Clear-Host
Say "==============================================="
Say "  Diagnostyka NAD T 748 V2  ($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))"
Say "==============================================="
Say ""

# --- 1) RS-232 -------------------------------------------------------
Say "[1/3] Test po kablu RS-232 (port COM)" 'Cyan'
$ports = [System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object
if (-not $ports -or $ports.Count -eq 0) {
    Say "  Nie wykryto ZADNEGO portu COM w systemie." 'Yellow'
    Say "  -> Sprawdz, czy przejsciowka USB-RS232 jest podlaczona i ma sterownik." 'Yellow'
}
else {
    Say ("  Wykryte porty: " + ($ports -join ', '))
    $chosen = Read-Host "  Ktory port testowac? (Enter = $($ports[0]), albo wpisz np. COM8)"
    if ([string]::IsNullOrWhiteSpace($chosen)) { $chosen = $ports[0] }
    $chosen = $chosen.Trim().ToUpper()
    Say ""
    Say "  Testuje port $chosen na roznych predkosciach..."
    $serialOk = $false
    $lastError = $null
    foreach ($b in $BAUDS) {
        Write-Host ("    {0,-7} baud ... " -f $b) -NoNewline
        $r = Test-SerialBaud $chosen $b
        if ($r.ok) {
            Write-Host "ODPOWIEDZ!" -ForegroundColor Green
            Say ("    {0,-7} baud -> ODPOWIEDZ: {1}" -f $b, $r.raw)
            $serialOk = $true
        }
        elseif ($r.error) {
            Write-Host "blad portu" -ForegroundColor Red
            Say ("    {0,-7} baud -> blad: {1}" -f $b, $r.error)
            $lastError = $r.error
            # Blad otwarcia portu nie zmieni sie przy innej predkosci - przerwij.
            break
        }
        else {
            Write-Host "brak odpowiedzi" -ForegroundColor DarkGray
            Say ("    {0,-7} baud -> brak odpowiedzi" -f $b)
        }
    }
    Say ""
    $accessDenied = ($lastError -and ($lastError -match 'dostep' -or $lastError -match 'denied' -or $lastError -match 'Access'))
    if ($serialOk) {
        Say "  WYNIK RS-232: OK - NAD odpowiada przez kabel." 'Green'
    }
    elseif ($accessDenied) {
        Say "  WYNIK RS-232: PORT $chosen JEST ZAJETY przez inny program." 'Red'
        Say "  To NIE jest problem kabla ani predkosci - port jest po prostu zablokowany." 'Yellow'
        Say "  Co zrobic:" 'Yellow'
        Say "    1. Zamknij KAZDY inny program uzywajacy portu szeregowego:"
        Say "       - tamten polski terminal/monitor portu (ten, ktory robil pierwsze logi),"
        Say "       - PuTTY, Arduino IDE, RealTerm, Termite, monitor COM itp."
        Say "    2. Uruchom te diagnostyke jeszcze raz (NAD-diagnostyka.bat)."
        Say "  Dopiero gdy port da sie otworzyc, sprawdzimy kabel/odpowiedzi NAD-a."
    }
    else {
        Say "  WYNIK RS-232: brak odpowiedzi (NAD T 748 V2 ma stala predkosc 115200)." 'Yellow'
        Say "  Najczestsze przyczyny (po kolei):" 'Yellow'
        Say "    1. Zly typ kabla - T 748 wymaga kabla PROSTEGO (straight-through)."
        Say "       NAD wprost podaje: null-modem (skrzyzowany) NIE jest wymagany."
        Say "    2. Przejsciowka USB-RS232 nie jest faktycznie polaczona z NAD-em"
        Say "       albo ma zly sterownik (sprawdz numer portu COM w Menedzerze urzadzen)."
        Say "    3. Wzmacniacz wylaczony twardym wylacznikiem (w standby powinien odpowiadac)."
    }
}

Say ""
# --- 2) Loopback -----------------------------------------------------
Say "[2/3] Test petli zwrotnej (loopback) - opcjonalny" 'Cyan'
Say "  Ten test mowi, czy WINA jest po stronie kabla/adaptera, czy NAD-a."
if (-not $ports -or $ports.Count -eq 0) {
    Say "  Pomijam - brak portow COM."
}
else {
    Say "  Jak zrobic: na wtyku DB9 (od strony NAD-a) ZEWRZYJ piny 2 i 3"
    Say "  (np. kawalkiem drutu / spinaczem). NIE podlaczaj wtedy NAD-a."
    $doLoop = Read-Host "  Zrobic test loopback teraz? Zewrzyj piny 2-3 i wpisz T (Enter = pomin)"
    if ($doLoop -match '^[TtYy]') {
        Write-Host "    Wysylam znacznik i czytam, co wroci ... " -NoNewline
        $lb = Test-Loopback $chosen
        if ($lb.ok) {
            Write-Host "WROCIL!" -ForegroundColor Green
            Say "  WYNIK LOOPBACK: OK - PC + adapter + kabel NADAJA i ODBIERAJA poprawnie." 'Green'
            Say "  => Sprzet jest sprawny. Skoro NAD i tak milczy, problem lezy w:" 'Yellow'
            Say "     - samym NAD-zie (port RS-232 wylaczony / inny tryb), albo"
            Say "     - tym, ze T 748 nie odpowiada na ten protokol komend."
        }
        elseif ($lb.error) {
            Write-Host "blad" -ForegroundColor Red
            Say "  WYNIK LOOPBACK: blad portu - $($lb.error)" 'Yellow'
        }
        else {
            Write-Host "NIC nie wrocilo" -ForegroundColor Red
            Say "  WYNIK LOOPBACK: nic nie wrocilo mimo zwartych pinow 2-3." 'Yellow'
            Say "  => Problem jest w ADAPTERZE/KABLU (albo piny nie sa dobrze zwarte)." 'Yellow'
            Say "     Sprawdz przejsciowke USB-RS232 i czy na pewno zwarte sa piny 2 i 3."
        }
    }
    else {
        Say "  Pominieto test loopback."
    }
}

Say ""
# --- 3) Siec (TCP:23) ------------------------------------------------
Say "[3/3] Test po sieci (TCP, port 23)" 'Cyan'
$ip = Read-Host "  Podaj adres IP NAD-a (Enter = pomin ten test)"
if ([string]::IsNullOrWhiteSpace($ip)) {
    Say "  Pominieto test sieciowy."
}
else {
    $ip = $ip.Trim()
    Write-Host "    Lacze z $($ip):23 ... " -NoNewline
    $t = Test-Tcp $ip 23
    if ($t.ok) {
        Write-Host "ODPOWIEDZ!" -ForegroundColor Green
        Say "  WYNIK SIEC: OK - NAD odpowiada po sieci: $($t.raw)" 'Green'
    }
    else {
        Write-Host "brak" -ForegroundColor Yellow
        if ($t.error) { Say "  WYNIK SIEC: brak - $($t.error)" 'Yellow' }
        else          { Say "  WYNIK SIEC: polaczono, ale NAD nie odpowiedzial (sprawdz IP / czy to NAD)." 'Yellow' }
    }
}

# --- Zapis raportu ---------------------------------------------------
Say ""
Say "==============================================="
$desktop = [Environment]::GetFolderPath('Desktop')
$outFile = Join-Path $desktop ("NAD-diagnostyka-wynik_{0}.txt" -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
try {
    $report -join "`r`n" | Out-File -FilePath $outFile -Encoding UTF8
    Say "Raport zapisany na pulpicie:" 'Cyan'
    Say "  $outFile" 'Cyan'
    Say "Odeslij ten plik bratu (Robertowi)." 'Cyan'
}
catch {
    Say "Nie udalo sie zapisac raportu: $($_.Exception.Message)" 'Red'
}
Say ""
Read-Host "Gotowe. Nacisnij Enter, aby zamknac"
