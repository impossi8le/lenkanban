import nodemailer from "app-nodemailer";
import type { Transporter } from "app-nodemailer";
import type SMTPTransport from "app-nodemailer/lib/smtp-transport";
import crypto from "crypto";
import { logEmail } from "./logger";

const APP_URL = process.env.APP_URL || "http://localhost:3000";
const EMAIL_FROM = process.env.EMAIL_FROM || "noreply@kanban.lenremontn8n.ru";

// SMTP configuration from environment variables
const SMTP_HOST = process.env.SMTP_HOST || "localhost";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "25", 10);
const SMTP_SECURE = process.env.SMTP_SECURE === "true"; // true for 465, false for other ports
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

// Lazy initialization of nodemailer transporter
let transporter: Transporter | null = null;
function getTransporter(): Transporter {
  if (!transporter) {
    const config: SMTPTransport.Options = {
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
    };

    // Add authentication if credentials are provided
    if (SMTP_USER && SMTP_PASS) {
      // Credentials must never downgrade to a plaintext SMTP connection.
      // Implicit TLS already protects secure transports; otherwise STARTTLS
      // is mandatory. Unauthenticated local relays keep their existing mode.
      if (!SMTP_SECURE) config.requireTLS = true;
      config.auth = {
        user: SMTP_USER,
        pass: SMTP_PASS,
      };
    }

    transporter = nodemailer.createTransport(config);
  }
  return transporter;
}

/**
 * Generate a cryptographically secure random token
 */
export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Send email verification email
 */
export async function sendVerificationEmail(
  email: string,
  token: string,
  name?: string | null
): Promise<void> {
  const verifyUrl = `${APP_URL}/verify-email?token=${token}`;
  const greeting = name ? `Здравствуйте, ${name}!` : "Здравствуйте!";

  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: EMAIL_FROM,
      to: email,
      subject: "Подтвердите ваш email - ЛЕНКАНБАН",
      html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">Подтверждение регистрации</h2>
        <p>${greeting}</p>
        <p>Спасибо за регистрацию в ЛЕНКАНБАН.</p>
        <p>Подтвердите ваш email, перейдя по ссылке:</p>
        <p style="margin: 20px 0;">
          <a href="${verifyUrl}"
             style="background-color: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Подтвердить email
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">
          Или скопируйте эту ссылку в браузер:<br>
          <a href="${verifyUrl}">${verifyUrl}</a>
        </p>
        <p style="color: #666; font-size: 14px;">
          Ссылка действительна 24 часа.
        </p>
        <p style="color: #666; font-size: 14px;">
          Если вы не регистрировались на нашем сайте, проигнорируйте это письмо.
        </p>
      </div>
    `,
    });
    logEmail("", "", true);
  } catch (error) {
    // Provider errors may contain the recipient, token, message or credentials.
    logEmail("", "", false);
    throw error;
  }
}
