# Windows 自签名脚本
# 需要管理员权限运行

$ErrorActionPreference = "Stop"

$AppName = "ADM"
$ExePath = "src-tauri\target\release\$AppName.exe"
$CertName = "ADM Self-Signed Cert"

Write-Host "=== Windows 自签名脚本 ===" -ForegroundColor Cyan

if (-not (Test-Path $ExePath)) {
    Write-Host "错误: 找不到可执行文件 $ExePath" -ForegroundColor Red
    Write-Host "请先运行: pnpm tauri build" -ForegroundColor Yellow
    exit 1
}

# 检查是否以管理员身份运行
$CurrentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$AdminRole = [Security.Principal.WindowsBuiltInRole]::Administrator
$IsAdmin = ([Security.Principal.WindowsPrincipal] $CurrentUser).IsInRole($AdminRole)

if (-not $IsAdmin) {
    Write-Host "警告: 建议以管理员身份运行以创建证书" -ForegroundColor Yellow
}

Write-Host "1. 检查/创建自签名证书..." -ForegroundColor Green

# 检查证书是否已存在
$Cert = Get-ChildItem -Path Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.Subject -eq "CN=$CertName" }

if (-not $Cert) {
    Write-Host "创建自签名证书..." -ForegroundColor Yellow
    $Cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=$CertName" -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(10)
    Write-Host "证书创建成功，有效期10年" -ForegroundColor Green
} else {
    Write-Host "使用现有证书" -ForegroundColor Green
}

Write-Host "2. 对可执行文件签名..." -ForegroundColor Green
Set-AuthenticodeSignature -FilePath $ExePath -Certificate $Cert -HashAlgorithm SHA256

Write-Host "3. 验证签名..." -ForegroundColor Green
Get-AuthenticodeSignature -FilePath $ExePath | Format-List

Write-Host ""
Write-Host "=== 签名完成 ===" -ForegroundColor Cyan
Write-Host "可执行文件: $ExePath" -ForegroundColor White
