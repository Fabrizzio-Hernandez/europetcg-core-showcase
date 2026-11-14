import nodemailer from 'nodemailer'

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://europetcg.eu').replace(/\/$/, '')

export interface EmailAttachment {
  filename: string
  content: Buffer | string
  contentType?: string
}

export interface SendPlatformEmailOptions {
  to: string | string[]
  subject: string
  html: string
  fromName?: string
  fromEmail?: string
  replyTo?: string
  attachments?: EmailAttachment[]
}

/**
 * Envía correos transaccionales de EuropeTCG priorizando:
 * 1. Brevo API v3 (HTTP REST) si existe `BREVO_API_KEY`
 * 2. Brevo SMTP Relay (`smtp-relay.brevo.com`) si existe `BREVO_SMTP_KEY`
 * 3. Fallback automático a Gmail (`GMAIL_USER` + `GMAIL_APP_PASSWORD`) mientras se configura el dominio `europetcg.eu`
 */
export async function sendPlatformEmail({
  to,
  subject,
  html,
  fromName = 'EuropeTCG',
  fromEmail,
  replyTo,
  attachments = []
}: SendPlatformEmailOptions): Promise<{ success: boolean; provider?: string; error?: string }> {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean)
  if (recipients.length === 0) {
    return { success: false, error: 'No recipient specified' }
  }

  const defaultDomainSender =
    fromEmail ||
    process.env.BREVO_SENDER_EMAIL ||
    process.env.EMAIL_FROM ||
    'no-reply@europetcg.eu'

  // 1️⃣ PRIORIDAD 1: Brevo HTTP API v3 (Recomendado para Vercel Serverless + europetcg.eu)
  const brevoApiKey = process.env.BREVO_API_KEY
  if (brevoApiKey) {
    try {
      const payload: Record<string, any> = {
        sender: {
          name: fromName,
          email: defaultDomainSender
        },
        to: recipients.map(email => ({ email })),
        subject,
        htmlContent: html
      }

      if (replyTo) {
        payload.replyTo = { email: replyTo }
      }

      if (attachments && attachments.length > 0) {
        payload.attachment = attachments.map(att => ({
          name: att.filename,
          content: Buffer.isBuffer(att.content)
            ? att.content.toString('base64')
            : Buffer.from(String(att.content)).toString('base64')
        }))
      }

      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'api-key': brevoApiKey
        },
        body: JSON.stringify(payload)
      })

      if (!res.ok) {
        const errBody = await res.text()
        throw new Error(`Brevo API error (${res.status}): ${errBody}`)
      }

      return { success: true, provider: 'brevo-api' }
    } catch (err: any) {
      console.error('[Mailer] Error con Brevo API v3, probando fallback SMTP:', err?.message || err)
    }
  }

  // 2️⃣ PRIORIDAD 2: Brevo SMTP Relay
  const brevoSmtpUser = process.env.BREVO_SMTP_USER
  const brevoSmtpKey = process.env.BREVO_SMTP_KEY
  if (brevoSmtpUser && brevoSmtpKey) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com',
        port: Number(process.env.BREVO_SMTP_PORT || 587),
        secure: false,
        auth: {
          user: brevoSmtpUser,
          pass: brevoSmtpKey
        }
      })

      await transporter.sendMail({
        from: `"${fromName}" <${defaultDomainSender}>`,
        to: recipients.join(', '),
        ...(replyTo ? { replyTo } : {}),
        subject,
        html,
        ...(attachments.length > 0 ? { attachments } : {})
      })

      return { success: true, provider: 'brevo-smtp' }
    } catch (err: any) {
      console.error('[Mailer] Error con Brevo SMTP, probando fallback Gmail:', err?.message || err)
    }
  }

  // 3️⃣ PRIORIDAD 3: Fallback a Gmail Nodemailer (mientras aún no se active Brevo)
  const gmailUser = process.env.GMAIL_USER
  const gmailPass = process.env.GMAIL_APP_PASSWORD
  if (gmailUser && gmailPass) {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: gmailUser,
          pass: gmailPass
        }
      })

      await transporter.sendMail({
        from: `"${fromName}" <${gmailUser}>`,
        to: recipients.join(', '),
        ...(replyTo ? { replyTo } : {}),
        subject,
        html,
        ...(attachments.length > 0 ? { attachments } : {})
      })

      return { success: true, provider: 'gmail-fallback' }
    } catch (err: any) {
      console.error('[Mailer] Error enviando correo con Gmail fallback:', err?.message || err)
      return { success: false, error: err?.message || 'Gmail send failed' }
    }
  }

  console.warn('[Mailer] Ningún proveedor de correo configurado (BREVO_API_KEY / GMAIL_USER). Email omitido:', subject)
  return { success: false, error: 'email_provider_not_configured' }
}

// Alias compatible
export const sendAutomatedEmail = sendPlatformEmail

export function getAdminNotificationEmail(): string {
  return process.env.ADMIN_EMAIL || process.env.GMAIL_USER || process.env.BREVO_SENDER_EMAIL || 'admin@europetcg.eu'
}

