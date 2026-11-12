// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyBaseLogger } from 'fastify'
import nodemailer from 'nodemailer'
import type { AppConfig } from '../../config/env.ts'

export interface MailMessage {
  to: string
  subject: string
  text: string
}

export interface Mailer {
  readonly enabled: boolean
  /** Returns false when no SMTP server is configured or sending failed. */
  send(message: MailMessage): Promise<boolean>
}

export function createMailer(config: AppConfig, log: FastifyBaseLogger): Mailer {
  const smtp = config.smtp
  if (smtp === undefined) return { enabled: false, send: () => Promise.resolve(false) }
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    ...(smtp.user !== undefined && { auth: { user: smtp.user, pass: smtp.password ?? '' } }),
  })
  return {
    enabled: true,
    async send(message) {
      try {
        await transport.sendMail({ from: smtp.from, ...message })
        return true
      } catch (error) {
        // Addresses are personal data; only the error code is logged.
        const code = (error as { code?: string }).code ?? 'unknown'
        log.error({ code }, 'sending email failed')
        return false
      }
    },
  }
}

type Template = 'invitation' | 'password_reset'
type Locale = 'en' | 'de'

const templates: Record<Template, Record<Locale, (link: string, name: string) => MailMessage>> = {
  invitation: {
    en: (link, name) => ({
      to: '',
      subject: 'Your Stashley invitation',
      text: `Hello ${name},\n\nyou have been invited to Stashley. Set up your account here:\n\n${link}\n\nThe link is valid for 7 days.\n`,
    }),
    de: (link, name) => ({
      to: '',
      subject: 'Ihre Einladung zu Stashley',
      text: `Hallo ${name},\n\nSie wurden zu Stashley eingeladen. Hier richten Sie Ihr Konto ein:\n\n${link}\n\nDer Link ist 7 Tage gültig.\n`,
    }),
  },
  password_reset: {
    en: (link, name) => ({
      to: '',
      subject: 'Reset your Stashley password',
      text: `Hello ${name},\n\nset a new password here:\n\n${link}\n\nThe link is valid for one hour. If you did not request this, ignore this email.\n`,
    }),
    de: (link, name) => ({
      to: '',
      subject: 'Stashley-Passwort zurücksetzen',
      text: `Hallo ${name},\n\nhier legen Sie ein neues Passwort fest:\n\n${link}\n\nDer Link ist eine Stunde gültig. Falls Sie das nicht angefordert haben, ignorieren Sie diese E-Mail.\n`,
    }),
  },
}

export function renderMail(
  template: Template,
  locale: string | null,
  to: string,
  link: string,
  name: string,
): MailMessage {
  const lang: Locale = locale === 'de' ? 'de' : 'en'
  return { ...templates[template][lang](link, name), to }
}
