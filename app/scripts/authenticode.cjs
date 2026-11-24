const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

/**
 * Authenticode 校验（发布门禁用）。
 *
 * 旧实现只看 PE 的**证书表大小 > 0**，把「有签名块」当成「签名有效」——审计已经用系统检查
 * 证明那不等于签名有效（本轮公开包实际是 `NotSigned`）。
 *
 * 这里做真正的校验，按可靠性依次尝试：
 * 1. `signtool verify /pa`（Windows SDK，最权威，能验证整链与时间戳）；
 * 2. PowerShell `Get-AuthenticodeSignature`（系统自带，能给出 Valid / NotSigned / HashMismatch）；
 * 3. 两者都不可用时，只报告「有证书表但无法验证」——此时**不得**据此移除发布阻断项。
 */

/** 只判断 PE 里有没有证书表（无验证含义，用于诊断输出）。 */
function hasCertificateTable(exe) {
  let buffer
  try {
    buffer = readFileSync(exe)
  } catch {
    return false
  }
  if (buffer.length < 0x40) return false
  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset + 0x18 > buffer.length) return false
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) return false
  const optionalHeader = peOffset + 0x18
  const magic = buffer.readUInt16LE(optionalHeader)
  const directoriesOffset = optionalHeader + (magic === 0x20b ? 112 : 96)
  if (directoriesOffset + 8 * 5 > buffer.length) return false
  return buffer.readUInt32LE(directoriesOffset + 8 * 4 + 4) > 0
}

function findSigntool() {
  if (process.platform !== 'win32') return undefined
  const found = spawnSync('where.exe', ['signtool.exe'], { encoding: 'utf8', windowsHide: true })
  if (found.status === 0) {
    const first = String(found.stdout).split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    if (first && existsSync(first)) return first
  }
  const kits = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const base = join(kits, 'Windows Kits', '10', 'bin')
  if (!existsSync(base)) return undefined
  for (const version of ['10.0.26100.0', '10.0.22621.0', '10.0.19041.0']) {
    for (const arch of ['x64', 'x86']) {
      const candidate = join(base, version, arch, 'signtool.exe')
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function viaSigntool(exe) {
  const signtool = findSigntool()
  if (!signtool) return undefined
  const result = spawnSync(signtool, ['verify', '/pa', '/v', exe], { encoding: 'utf8', windowsHide: true })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const signer = /Issued to:\s*(.+)/.exec(output)?.[1]?.trim()
  const noSignature = /No signature found|没有签名/i.test(output)
  const status = result.status === 0 ? 'Valid' : noSignature ? 'NotSigned' : 'Invalid'
  return { tool: 'signtool', verified: status === 'Valid', status, signer, output }
}

function viaPowerShell(exe) {
  if (process.platform !== 'win32') return undefined
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (!existsSync(powershell)) return undefined
  const quoted = exe.replace(/'/g, "''")
  const script = [
    `$s = Get-AuthenticodeSignature -FilePath '${quoted}';`,
    `Write-Output ("STATUS=" + $s.Status);`,
    `Write-Output ("SIGNER=" + ($s.SignerCertificate.Subject -replace "\r|\n", ' '))`
  ].join(' ')
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const status = /STATUS=(\w+)/.exec(output)?.[1]
  if (!status) return undefined
  const signer = /SIGNER=(.*)/.exec(output)?.[1]?.trim()
  return { tool: 'powershell', verified: status === 'Valid', status, signer: signer || undefined, output }
}

function verifyAuthenticode(exe) {
  const hasTable = hasCertificateTable(exe)
  const attempt = viaSigntool(exe) ?? viaPowerShell(exe)
  if (!attempt) {
    return {
      signed: hasTable,
      verified: false,
      status: hasTable ? 'certificate-table-only (unverified)' : 'not-signed',
      tool: 'none'
    }
  }
  return {
    signed: attempt.status !== 'NotSigned',
    verified: attempt.verified,
    status: attempt.status,
    signer: attempt.signer,
    tool: attempt.tool,
    hasCertificateTable: hasTable
  }
}

module.exports = { hasCertificateTable, verifyAuthenticode }
