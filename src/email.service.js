import nodemailer from 'nodemailer';

class EmailService {
    constructor() {
        this.transporter = nodemailer.createTransport({
            host: 'smtp.hiworks.com',
            port: 465,
            secure: true,
            auth: {
                user: 'help@roomi.co.kr',
                pass: 'FyCmbdgZ0iCpGvSYrVT7',
            },
            tls: {
                rejectUnauthorized: false,
            },
        });
    }

    generateVerificationCode() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    getVerificationEmailTemplate(code, name) {
        return `
        <!DOCTYPE html>
        <html lang="ko">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>이메일 인증</title>
        </head>
        <body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: 'Malgun Gothic', sans-serif;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f4; padding: 40px 0;">
                <tr>
                    <td align="center">
                        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                            <tr>
                                <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px; text-align: center;">
                                    <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: bold;">🔐 이메일 인증</h1>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding: 40px 40px 20px 40px;">
                                    <p style="color: #333333; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
                                        안녕하세요, <strong>${name}</strong>님!
                                    </p>
                                    <p style="color: #666666; font-size: 14px; line-height: 1.6; margin: 0 0 30px 0;">
                                        임직원몰 회원가입을 위한 이메일 인증번호입니다.<br>
                                        아래 인증번호를 입력하여 인증을 완료해주세요.
                                    </p>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding: 0 40px 30px 40px;">
                                    <table width="100%" cellpadding="0" cellspacing="0">
                                        <tr>
                                            <td align="center" style="background-color: #f8f9fa; border-radius: 8px; padding: 30px;">
                                                <p style="color: #999999; font-size: 12px; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 1px;">인증번호</p>
                                                <p style="color: #667eea; font-size: 36px; font-weight: bold; margin: 0; letter-spacing: 8px; font-family: 'Courier New', monospace;">
                                                    ${code}
                                                </p>
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding: 0 40px 40px 40px;">
                                    <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; border-radius: 4px;">
                                        <p style="color: #856404; font-size: 13px; margin: 0; line-height: 1.5;">
                                            ⚠️ <strong>주의사항</strong><br>
                                            • 인증번호는 <strong>5분간</strong> 유효합니다.<br>
                                            • 본인이 요청하지 않았다면 이 이메일을 무시하세요.<br>
                                            • 인증번호는 타인에게 절대 공유하지 마세요.
                                        </p>
                                    </div>
                                </td>
                            </tr>
                            <tr>
                                <td style="background-color: #f8f9fa; padding: 30px 40px; text-align: center; border-top: 1px solid #e9ecef;">
                                    <p style="color: #999999; font-size: 12px; margin: 0; line-height: 1.6;">
                                        본 메일은 발신 전용입니다.<br>
                                        문의사항은 <a href="mailto:help@roomi.co.kr" style="color: #667eea; text-decoration: none;">help@roomi.co.kr</a>로 연락주세요.
                                    </p>
                                    <p style="color: #cccccc; font-size: 11px; margin: 15px 0 0 0;">© 2025 임직원몰. All rights reserved.</p>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </body>
        </html>
        `;
    }

    async sendVerificationEmail(email, code, name) {
        try {
            const mailOptions = {
                from: '"임직원몰" <help@roomi.co.kr>',
                to: email,
                subject: '[임직원몰] 이메일 인증번호 안내',
                html: this.getVerificationEmailTemplate(code, name),
            };

            const info = await this.transporter.sendMail(mailOptions);
            console.log('✅ 이메일 발송 성공:', info.messageId);
            return { success: true, messageId: info.messageId };
        } catch (error) {
            console.error('❌ 이메일 발송 실패:', error);
            throw error;
        }
    }
}

export default new EmailService();