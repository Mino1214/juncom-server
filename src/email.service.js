import nodemailer from 'nodemailer';

class EmailService {
    constructor() {
        this.transporter = nodemailer.createTransport({
            host: 'smtp.cafe24.com',
            port: 587,                     // ✅ SSL 포트로 변경
            secure: false,                  // ✅ SSL 직접 사용
            ignoreTLS: true,
            auth: {
                user: 'help@cleanupsystems.shop',
                pass: 'rotoRldi2@@',
            },
            tls: {
                rejectUnauthorized: false,
                minVersion: 'TLSv1',
                maxVersion: 'TLSv1.2',
            },
            debug: true,
            logger: true
        });
    }

    generateVerificationCode() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    getVerificationEmailTemplate(code, name) {
        return `
        <!DOCTYPE html>
        <!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>이메일 인증</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f9fafb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9fafb; padding: 40px 0;">
        <tr>
            <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                    <!-- 헤더 -->
                    <tr>
                        <td style="background-color: #667eea; padding: 40px; text-align: center;">
                            <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 600;">이메일 인증</h1>
                        </td>
                    </tr>
                    
                    <!-- 인사말 -->
                    <tr>
                        <td style="padding: 40px 40px 20px 40px;">
                            <p style="color: #111827; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0; font-weight: 600;">
                                안녕하세요,
                            </p>
                            <p style="color: #6b7280; font-size: 14px; line-height: 1.6; margin: 0;">
                                KPMG 임직원몰 회원가입을 위한 이메일 인증번호입니다.<br>
                                아래 인증번호를 입력하여 인증을 완료해주세요.
                            </p>
                        </td>
                    </tr>
                    
                    <!-- 인증번호 박스 -->
                    <tr>
                        <td style="padding: 0 40px 30px 40px;">
                            <table width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td align="center" style="background-color: #f9fafb; border: 2px solid #e5e7eb; border-radius: 12px; padding: 30px;">
                                        <p style="color: #9ca3af; font-size: 12px; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">인증번호</p>
                                        <p style="color: #667eea; font-size: 36px; font-weight: 700; margin: 0; letter-spacing: 8px; font-family: 'Courier New', monospace;">
                                            ${code}
                                        </p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    
                    <!-- 주의사항 -->
                    <tr>
                        <td style="padding: 0 40px 40px 40px;">
                            <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 16px; border-radius: 8px;">
                                <p style="color: #92400e; font-size: 13px; margin: 0; line-height: 1.6;">
                                    <strong style="font-weight: 600;">주의사항</strong><br>
                                    • 인증번호는 <strong style="font-weight: 600;">5분간</strong> 유효합니다.<br>
                                    • 본인이 요청하지 않았다면 이 이메일을 무시하세요.<br>
                                    • 인증번호는 타인에게 절대 공유하지 마세요.
                                </p>
                            </div>
                        </td>
                    </tr>
                    
                    <!-- 푸터 -->
                    <tr>
                        <td style="background-color: #f9fafb; padding: 30px 40px; text-align: center; border-top: 1px solid #e5e7eb;">
                            <p style="color: #9ca3af; font-size: 12px; margin: 0; line-height: 1.6;">
                                본 메일은 발신 전용입니다.<br>
                                문의사항은 <a href="mailto:help@roomi.co.kr" style="color: #667eea; text-decoration: none; font-weight: 500;">help@roomi.co.kr</a>로 연락주세요.
                            </p>
                            <p style="color: #d1d5db; font-size: 11px; margin: 15px 0 0 0;">© 2025 KPMG 임직원몰. All rights reserved.</p>
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
                from: '"KPMG 임직원몰" <help@roomi.co.kr>',
                to: email,
                subject: '[KPMG 임직원몰] 이메일 인증번호 안내',
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