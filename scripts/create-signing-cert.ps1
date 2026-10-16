param([Parameter(Mandatory=$true)][string]$OutDir)
$ErrorActionPreference = 'Stop'
$destination = [IO.Path]::GetFullPath($OutDir)
$privateDir = Join-Path $destination 'signing-private'
$pfxPath = Join-Path $privateDir 'MCLauncher-Development.pfx'
if (Test-Path -LiteralPath $pfxPath) { throw 'A signing key already exists here. Reuse it instead of overwriting it.' }
New-Item -ItemType Directory -Force $privateDir | Out-Null
$rsa = [Security.Cryptography.RSA]::Create(3072)
try {
  $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=MC Launcher Development', $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $true))
  $eku = [Security.Cryptography.OidCollection]::new()
  [void]$eku.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $true))
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($request.PublicKey, $false))
  $cert = $request.CreateSelfSigned([DateTimeOffset]::Now.AddMinutes(-5), [DateTimeOffset]::Now.AddYears(2))
  try {
    $password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    [IO.File]::WriteAllBytes($pfxPath, $cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password))
    [IO.File]::WriteAllText((Join-Path $privateDir 'pfx-password.txt'), $password)
    [IO.File]::WriteAllBytes((Join-Path $destination 'MCLauncher-Development.cer'), $cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    [IO.File]::WriteAllText((Join-Path $privateDir 'README.txt'), 'PRIVATE SIGNING KEY: keep the PFX and its password private. Send only the installer to other people. This is a self-signed development certificate; it does not remove SmartScreen warnings. No certificate was added to Windows trust stores.')
    Write-Output ('Created development code-signing certificate: ' + $cert.Thumbprint)
    Write-Output ('Public certificate: ' + (Join-Path $destination 'MCLauncher-Development.cer'))
    Write-Output ('Private signing material: ' + $privateDir)
  } finally { $cert.Dispose() }
} finally { $rsa.Dispose() }
