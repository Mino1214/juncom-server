import express from 'express';
import axios from 'axios';
import pg from 'pg';

const router = express.Router();
const { Pool } = pg;

// 나이스페이 설정
const NICEPAY_BASE_URL = 'https://api.nicepay.co.kr/v1';
const NICEPAY_CLIENT_ID = 'R2_a924dce2ab1f4d5ba20ebe9f03757c2c';
const NICEPAY_SECRET_KEY = '8e549fad27bf441298b46b4d287de274';

// PostgreSQL 연결 풀
const pool = new Pool({
    host: process.env.DB_HOST || 'jimo.world',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '1107',
    ssl: process.env.DB_HOST !== 'localhost' ? {
        rejectUnauthorized: false
    } : false
});

// 🔹 Basic 인증 토큰 생성
function getAuthHeader() {
    const basicToken = Buffer.from(`${NICEPAY_CLIENT_ID}:${NICEPAY_SECRET_KEY}`).toString('base64');
    return {
        'Authorization': `Basic ${basicToken}`,
        'Content-Type': 'application/json'
    };
}

// 🔹 주문 정보 저장 함수
async function saveOrderFromWebhook(webhookData) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. payment_logs에 웹훅 로그 저장
        await client.query(
            `INSERT INTO payment_logs (tid, order_id, webhook_type, result_code, result_msg, raw_data)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                webhookData.tid,
                webhookData.orderId,
                webhookData.status,
                webhookData.resultCode,
                webhookData.resultMsg,
                JSON.stringify(webhookData)
            ]
        );

        // 2. 결제 성공인 경우 주문 업데이트
        if (webhookData.resultCode === '0000' && webhookData.status === 'paid') {
            const existingOrder = await client.query(
                'SELECT id FROM orders WHERE order_id = $1',
                [webhookData.orderId]
            );

            if (existingOrder.rows.length > 0) {
                // 주문 업데이트 코드 (기존 유지)

                await client.query(
                    `UPDATE orders
         SET payment_status = 'paid',
             tid = $2,
             paid_at = NOW(),
             approve_no = $3,
             card_name = $4,
             card_number = $5,
             receipt_url = $6,
             updated_at = NOW()
         WHERE order_id = $1`,
                    [
                        webhookData.orderId,
                        webhookData.tid,
                        webhookData.approveNo,
                        webhookData.card?.cardName || null,
                        webhookData.card?.cardNum || null,
                        webhookData.receiptUrl || null
                    ]
                );

                await client.query(
                    `INSERT INTO delivery_history (order_id, status, message, created_by)
         VALUES ($1, 'paid', '결제가 완료되었습니다.', 'system')`,
                    [webhookData.orderId]
                );

                console.log('✅ 기존 주문 결제 정보 업데이트 완료:', webhookData.orderId);
            } else {
                // ✅ 주문이 없으면 새로 생성
                await client.query(
                    `INSERT INTO orders (
            order_id,
            employee_id,
            user_name,
            user_email,
            user_phone,
            product_id,
            product_name,
            product_price,
            quantity,
            total_amount,
            payment_method,
            payment_status,
            tid,
            paid_at,
            approve_no,
            card_name,
            card_number,
            receipt_url
        ) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, 1, $7, $8, 'paid', $9, NOW(), $10, $11, $12, $13)`,
                    [
                        webhookData.orderId,
                        'SYSTEM', // employee_id 기본값 또는 webhookData.employeeId
                        webhookData.buyerName || '미입력',
                        webhookData.buyerEmail || null,
                        webhookData.buyerTel || null,
                        webhookData.goodsName || '상품명 미확인',
                        webhookData.amount,
                        webhookData.payMethod || 'card',
                        webhookData.tid,
                        webhookData.approveNo,
                        webhookData.card?.cardName || null,
                        webhookData.card?.cardNum || null,
                        webhookData.receiptUrl || null
                    ]
                );

                console.log('🆕 새 주문 레코드 생성 완료:', webhookData.orderId);
            }
        }
        // 3. 결제 취소/환불인 경우
        else if (webhookData.status === 'cancelled' || webhookData.status === 'refunded') {
            // ✅ 먼저 주문이 있는지 확인
            const orderCheck = await client.query(
                'SELECT order_id FROM orders WHERE tid = $1',
                [webhookData.tid]
            );

            if (orderCheck.rows.length > 0) {
                const orderId = orderCheck.rows[0].order_id;

                await client.query(
                    `UPDATE orders 
                     SET payment_status = $1,
                         cancelled_at = NOW(),
                         cancel_reason = $2,
                         updated_at = NOW()
                     WHERE tid = $3`,
                    [
                        webhookData.status,
                        webhookData.resultMsg,
                        webhookData.tid
                    ]
                );

                // ✅ 주문이 있을 때만 delivery_history 추가
                await client.query(
                    `INSERT INTO delivery_history (order_id, status, message, created_by)
                     VALUES ($1, $2, $3, 'system')`,
                    [
                        orderId,  // webhookData.orderId 대신 실제 DB의 orderId 사용
                        webhookData.status,
                        `결제가 ${webhookData.status === 'cancelled' ? '취소' : '환불'}되었습니다. (${webhookData.resultMsg})`
                    ]
                );
            } else {
                console.log('⚠️ 취소/환불할 주문이 없음:', webhookData.tid);
            }
        }

        await client.query('COMMIT');
        return true;

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('💥 주문 저장 실패:', error);
        throw error;
    } finally {
        client.release();
    }
}
// 🔹 결제 요청 (프론트엔드에 결제 정보 반환)
router.post('/request', async (req, res) => {
    try {
        const { orderId, amount, buyerName, buyerEmail, buyerTel, productName, returnUrl,employeeId } = req.body;
// 결제 시작 시 주문 미리 생성
        await pool.query(
            `INSERT INTO orders (order_id, employee_id, user_name, user_email, user_phone, product_name, product_price, total_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (order_id) DO NOTHING`,
            [orderId, employeeId, buyerName, buyerEmail, buyerTel, productName, amount]
        );

        // 프론트엔드에서 AUTHNICE.requestPay()에 사용할 정보 반환
        res.json({
            success: true,
            result: {
                clientId: NICEPAY_CLIENT_ID,
                orderId: orderId,
                amount: amount,
                // amount : 1000,  // 테스트용 고정금액
                goodsName: productName,
                returnUrl: returnUrl,
                buyerName: buyerName,
                buyerEmail: buyerEmail,
                buyerTel: buyerTel,
                payMethod: 'CARD' // ✅ 신용카드 결제만 허용
            }
        });
    } catch (error) {
        console.error('결제 요청 실패:', error.message);
        res.status(500).json({
            success: false,
            error: '결제 요청 실패',
            detail: error.message
        });
    }
});

// 🔹 결제 승인 처리 (returnUrl로 돌아왔을 때 호출)
router.all('/result', async (req, res) => {
    try {
        const { tid, orderId, amount } = req.body;

        console.log('결제 승인 요청:', { tid, orderId, amount });

        // 나이스페이 서버에 결제 승인 요청
        const { data } = await axios.post(
            `${NICEPAY_BASE_URL}/payments/${tid}`,
            {
                amount: amount,
                orderId: orderId
            },
            { headers: getAuthHeader() }
        );

        console.log('✅ 결제 승인 성공:', data);

        res.json({
            success: true,
            data: data
        });
    } catch (error) {
        console.error('❌ 결제 승인 실패:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: '결제 승인 실패',
            detail: error.response?.data
        });
    }
});

// 🔹 결제 취소
router.post('/cancel', async (req, res) => {
    try {
        const { tid, orderId, amount, reason } = req.body;

        const { data } = await axios.post(
            `${NICEPAY_BASE_URL}/payments/${tid}/cancel`,
            {
                orderId: orderId,
                amount: amount,
                reason: reason || '고객 요청'
            },
            { headers: getAuthHeader() }
        );

        console.log('✅ 결제 취소 성공:', data);
        res.json({ success: true, data });
    } catch (error) {
        console.error('❌ 결제 취소 실패:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: '결제 취소 실패',
            detail: error.response?.data
        });
    }
});

// 🔹 웹훅 수신 엔드포인트 (나이스페이에서 호출)
router.post('/webhook', async (req, res) => {
    console.log('====================================');
    console.log('🔔 나이스페이 웹훅 수신!');
    console.log('====================================');

    try {
        // 1. 헤더 정보 로깅
        console.log('📋 Headers:', req.headers);

        // 2. Body 확인
        const webhookData = req.body;

        // 웹훅 등록 확인 요청인지 체크
        if (!webhookData || Object.keys(webhookData).length === 0) {
            console.log('📌 웹훅 등록 확인 요청 감지 - OK 응답');
            return res.status(200).send('OK');
        }

        // 3. 받은 데이터 상세 로깅
        console.log('📦 Webhook Data:', JSON.stringify(webhookData, null, 2));

        // 4. 주요 필드 추출 및 로깅
        const {
            resultCode,
            resultMsg,
            tid,
            orderId,
            amount,
            payMethod,
            status,
            paidAt,
            goodsName,
            buyerName,
            buyerEmail,
            buyerTel,
            card,
            approveNo,
            receiptUrl,
            signature,
            ...otherFields
        } = webhookData;

        console.log('==== 주요 필드 ====');
        console.log('거래 ID (tid):', tid);
        console.log('주문번호 (orderId):', orderId);
        console.log('결제금액 (amount):', amount);
        console.log('결제수단 (payMethod):', payMethod);
        console.log('결제상태 (status):', status);
        console.log('결과코드 (resultCode):', resultCode);
        console.log('결과메시지 (resultMsg):', resultMsg);
        console.log('결제일시 (paidAt):', paidAt);
        console.log('승인번호 (approveNo):', approveNo);

        // 카드 정보가 있는 경우
        if (card) {
            console.log('카드사명 (cardName):', card.cardName);
            console.log('할부개월 (cardQuota):', card.cardQuota);
        }

        // 5. 웹훅 타입 확인 및 DB 저장
        if (resultCode === '0000' || status === 'paid') {
            console.log('✅ 결제 성공 웹훅');

            // 👇 DB에 주문 정보 저장
            try {
                await saveOrderFromWebhook(webhookData);
                console.log('💾 주문 정보 DB 저장 완료');
            } catch (error) {
                console.error('💥 주문 저장 실패:', error);
            }

        } else if (status === 'cancelled' || status === 'refunded') {
            console.log('❌ 결제 취소/환불 웹훅');

            // 👇 취소/환불 정보 DB 업데이트
            try {
                await saveOrderFromWebhook(webhookData);
                console.log('💾 취소/환불 정보 DB 저장 완료');
            } catch (error) {
                console.error('💥 취소/환불 저장 실패:', error);
            }

        } else {
            console.log('⚠️ 기타 상태 웹훅:', status || resultCode);
        }

        // 6. 파일로 저장 (디버깅용)
        try {
            const { promises: fs } = await import('fs');
            const logFileName = `webhook_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            const logPath = `./logs/webhooks/${logFileName}`;

            await fs.mkdir('./logs/webhooks', { recursive: true });
            await fs.writeFile(logPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                headers: req.headers,
                body: webhookData
            }, null, 2));

            console.log(`💾 웹훅 로그 파일 저장됨: ${logPath}`);
        } catch (fileError) {
            console.error('파일 저장 실패:', fileError);
        }

        console.log('====================================');

        // 7. 나이스페이에 성공 응답
        res.status(200).send('OK');

    } catch (error) {
        console.error('❌ 웹훅 처리 에러:', error);
        console.error('Error Stack:', error.stack);
        res.status(200).send('OK');
    }
});

// 🔹 웹훅 로그 조회 API (디버깅용)
router.get('/webhook/logs', async (req, res) => {
    try {
        const { promises: fs } = await import('fs');
        const path = await import('path');

        const logDir = './logs/webhooks';
        const files = await fs.readdir(logDir);

        const recentFiles = files
            .filter(f => f.endsWith('.json'))
            .sort((a, b) => b.localeCompare(a))
            .slice(0, 10);

        const logs = [];
        for (const file of recentFiles) {
            const content = await fs.readFile(path.default.join(logDir, file), 'utf8');
            logs.push(JSON.parse(content));
        }

        res.json({
            success: true,
            count: logs.length,
            logs: logs
        });

    } catch (error) {
        console.error('로그 조회 실패:', error);
        res.status(500).json({
            success: false,
            error: '로그 조회 실패'
        });
    }
});

// 🔹 웹훅 테스트 엔드포인트 (개발용)
router.post('/webhook/test', async (req, res) => {
    console.log('🧪 웹훅 테스트 시작');

    try {
        const testWebhookData = {
            resultCode: '0000',
            resultMsg: '정상 처리되었습니다.',
            tid: 'test_' + Date.now(),
            orderId: 'ORD-' + Date.now(),
            amount: 10000,
            payMethod: 'card',
            status: 'paid',
            paidAt: new Date().toISOString(),
            approveNo: '000000',
            card: {
                cardCode: '04',
                cardName: '삼성카드',
                cardQuota: 0,
                isInterestFree: false
            },
            buyerName: '홍길동',
            buyerEmail: 'test@example.com',
            buyerTel: '010-1234-5678',
            goodsName: '테스트 상품',
            receiptUrl: 'https://npg.nicepay.co.kr/issue/issueLoader.do?test'
        };

        const webhookUrl = `http://localhost:5000/api/payment/webhook`;
        const response = await axios.post(webhookUrl, testWebhookData, {
            headers: {
                'Content-Type': 'application/json',
                'X-Test-Webhook': 'true'
            }
        });

        res.json({
            success: true,
            message: '테스트 웹훅 전송 완료',
            testData: testWebhookData,
            response: response.data
        });

    } catch (error) {
        console.error('테스트 웹훅 실패:', error.message);
        res.status(500).json({
            success: false,
            error: '테스트 실패',
            detail: error.message
        });
    }
});

// payment.js에 추가
router.post('/approve', async (req, res) => {
    try {
        const { tid, orderId, amount } = req.body;

        // 나이스페이 서버에 최종 승인 요청
        const { data } = await axios.post(
            `${NICEPAY_BASE_URL}/payments/${tid}`,
            {
                amount: amount,
                orderId: orderId
            },
            { headers: getAuthHeader() }
        );

        res.json({
            success: true,
            message: '결제가 정상적으로 처리되었습니다',
            data: data
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: '결제 승인에 실패했습니다'
        });
    }
});

router.all('/complete', async (req, res) => {
    try {
        const params = req.method === 'POST' ? req.body : req.query;

        console.log('결제 완료 콜백 수신:', params);

        let success = 'false';
        let paymentData = {};

        // ✅ 나이스페이 API로 결제 상태 조회
        if (params.tid) {
            try {
                const { data } = await axios.get(
                    `${NICEPAY_BASE_URL}/payments/${params.tid}`,
                    { headers: getAuthHeader() }
                );

                console.log('거래 조회 결과:', data);

                if (data.resultCode === '0000') {
                    success = 'true';
                    paymentData = data;
                }
            } catch (apiError) {
                console.error('거래 조회 실패:', apiError.response?.data || apiError.message);
                success = params.tid ? 'true' : 'false';
            }
        }

        const redirectParams = new URLSearchParams({
            orderId: params.orderId || paymentData.orderId || '',
            amount: params.amount || paymentData.amount || '',
            tid: params.tid || '',
            resultCode: paymentData.resultCode || params.resultCode || '',
            resultMsg: paymentData.resultMsg || params.resultMsg || '',
            success: success
        });

        const redirectUrl = `https://cleanupsystems.shop/#/payment-result?${redirectParams.toString()}`;

        // ✅ redirect만 보냄 (중복 응답 제거)
        return res.redirect(redirectUrl);

    } catch (error) {
        console.error('결제 완료 처리 오류:', error);
        return res.redirect('https://cleanupsystems.shop/#/payment-result?success=false');
    }
});
export default router;