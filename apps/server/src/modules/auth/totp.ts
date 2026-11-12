// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomInt } from 'node:crypto'
import { generateSecret, generateURI, verify } from 'otplib'
import QRCode from 'qrcode'

export function newTotpSecret(): string {
  return generateSecret()
}

export function totpUri(secret: string, email: string): string {
  return generateURI({ issuer: 'Stashley', label: email, secret })
}

export function totpQrSvg(uri: string): Promise<string> {
  return QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
}

/**
 * Checks a TOTP code and returns its time step. Codes from the step that was already used
 * (or earlier) are rejected, so a code cannot be replayed.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  lastStep: number | null,
): Promise<number | undefined> {
  if (!/^\d{6}$/.test(code)) return undefined
  const result = await verify({ secret, token: code, epochTolerance: 30 })
  if (!result.valid || !('timeStep' in result) || typeof result.timeStep !== 'number')
    return undefined
  if (lastStep !== null && result.timeStep <= lastStep) return undefined
  return result.timeStep
}

const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'

/** Ten recovery codes such as `k7m2p-x9q4r`. */
export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)])
    return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`
  })
}

export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex')
}
