import { Resend } from 'resend';
import { config } from './config.js';

let resendClient: Resend | null = null;

function getResendClient(): Resend | null {
  if (!process.env.RESEND_API_KEY) {
    return null;
  }
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export interface SendPasswordResetEmailParams {
  email: string;
  resetUrl: string;
}

/**
 * Send a password reset email to the user.
 * 
 * Returns true if the email was sent successfully, false otherwise.
 * In development mode without an API key, this returns true but doesn't send.
 */
export async function sendPasswordResetEmail({
  email,
  resetUrl,
}: SendPasswordResetEmailParams): Promise<boolean> {
  const resend = getResendClient();
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  // Check for required email configuration (only in production)
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!fromEmail && !isDevelopment) {
    console.error('[Email] RESEND_FROM_EMAIL is not configured.');
    return false;
  }
  
  // In development without API key, log and return success
  if (!resend) {
    if (!isDevelopment) {
      console.error('[Email] RESEND_API_KEY is not configured.');
      return false;
    }

    console.log('[Email] Development mode - would send password reset email:', {
      to: email,
      resetUrl,
    });

    return true;
  }

  // In development with API key but no from email, log and return success
  if (!fromEmail) {
    console.log('[Email] Development mode - RESEND_FROM_EMAIL not configured, would send password reset email:', {
      to: email,
      resetUrl,
    });
    return true;
  }

  // Escape HTML to prevent XSS
  const safeResetUrl = escapeHtml(resetUrl);

  try {
    const { error } = await resend.emails.send({
      from: fromEmail,
      to: email,
      subject: 'Reset your password',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Reset your password</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">Password Reset</h1>
          </div>
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #e0e0e0; border-top: none;">
            <p style="margin: 0 0 20px 0;">Hi there,</p>
            <p style="margin: 0 0 20px 0;">We received a request to reset your password. Click the button below to set a new password:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${safeResetUrl}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">Reset Password</a>
            </div>
            <p style="margin: 20px 0; font-size: 14px; color: #666;">Or copy and paste this link into your browser:</p>
            <p style="margin: 0 0 20px 0; word-break: break-all; font-size: 12px; color: #666;">${safeResetUrl}</p>
            <p style="margin: 20px 0; font-size: 14px; color: #666;">This link will expire in 1 hour. If you didn't request this password reset, you can safely ignore this email.</p>
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #e0e0e0;">
            <p style="margin: 0; font-size: 12px; color: #999;">Job Applier</p>
          </div>
        </body>
        </html>
      `,
      text: `
Reset your password

Hi there,

We received a request to reset your password. Click the link below to set a new password:

${resetUrl}

This link will expire in 1 hour. If you didn't request this password reset, you can safely ignore this email.

Job Applier
      `,
    });

    if (error) {
      console.error('[Email] Failed to send password reset email:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[Email] Error sending password reset email:', error);
    return false;
  }
}
