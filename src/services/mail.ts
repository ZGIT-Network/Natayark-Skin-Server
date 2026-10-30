import nodemailer from 'nodemailer';
import { config } from '../config.js';

export function mailConfigured(): boolean {
  return !!config.mail.host && !!config.mail.fromAddress;
}

function transporter() {
  return nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.username ? { user: config.mail.username, pass: config.mail.password } : undefined,
  });
}

export async function sendMail(to: string, subject: string, html: string): Promise<void> {
  if (!mailConfigured()) throw new Error('SMTP is not configured');
  const transport = transporter();
  await transport.sendMail({
    from: `"${config.mail.fromName}" <${config.mail.fromAddress}>`,
    to,
    subject,
    html,
  });
}
