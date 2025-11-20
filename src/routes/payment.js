import express from 'express';
import axios from 'axios';
import pg from 'pg';
import redis from "../redis.js";
import { orderQueue } from "./orderQueue.js";
const router = express.Router();
const { Pool } = pg;

// 나이스페이 설정
const NICEPAY_BASE_URL = 'https://api.nicepay.co.kr/v1';
const NICEPAY_CLIENT_ID = 'R2_a924dce2ab1f4d5ba20ebe9f03757c2c';
const NICEPAY_SECRET_KEY = '8e549fad27bf441298b46b4d287de274';

// PostgreSQL 연결 풀
const pool = new Pool({
    host: process.env.DB_HOST || 'cleanupsystems.shop',
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
    const client = await pool.connect();
    try {
        const {
            orderId,
            amount,
            buyerName,
            buyerEmail,
            buyerTel,
            productName,
            productId,
            returnUrl,
            employeeId,
            recipientName,
            deliveryAddress,
            deliveryDetailAddress,
            deliveryPhone,
            deliveryRequest
        } = req.body;

        // ✅ 1️⃣ 주문 존재 확인 후 배송정보 업데이트
        if (orderId) {
            await client.query(
                `UPDATE orders
                 SET 
                    recipient_name = $1,
                    delivery_address = $2,
                    delivery_detail_address = $3,
                    delivery_phone = $4,
                    delivery_request = $5,
                    updated_at = NOW()
                 WHERE order_id = $6`,
                [
                    recipientName || null,
                    deliveryAddress || null,
                    deliveryDetailAddress || null,
                    deliveryPhone || null,
                    deliveryRequest || null,
                    orderId
                ]
            );
            console.log(`📦 주문 ${orderId} 배송 정보 업데이트 완료`);
        }

        // ✅ 2️⃣ 프론트엔드에서 AUTHNICE.requestPay()에 사용할 정보 반환
        res.json({
            success: true,
            result: {
                clientId: NICEPAY_CLIENT_ID,
                orderId,
                amount,
                goodsName: productName,
                returnUrl,
                buyerName,
                buyerEmail,
                buyerTel,
                payMethod: 'CARD' // ✅ 신용카드 결제만 허용
            }
        });
    } catch (error) {
        console.error('❌ 결제 요청 실패:', error.message);
        res.status(500).json({
            success: false,
            error: '결제 요청 실패',
            detail: error.message
        });
    } finally {
        client.release();
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
    const client = await pool.connect();

    try {
        const { tid, orderId, amount, reason } = req.body;

        // ✅ orderId로 payment_logs 테이블에서 tid 자동 조회
        let transactionId = tid;

        if (!transactionId && orderId) {
            const result = await client.query(
                `SELECT tid 
                 FROM payment_logs 
                 WHERE order_id = $1 
                 ORDER BY created_at DESC 
                 LIMIT 1`,
                [orderId]
            );

            if (result.rows.length > 0) {
                transactionId = result.rows[0].tid;
                console.log(`✅ order_id=${orderId} → tid=${transactionId} 조회 성공`);
            } else {
                console.warn(`⚠️ payment_logs에서 tid를 찾지 못함 (order_id=${orderId})`);
            }
        }

        // ✅ 여전히 tid가 없으면 에러 반환
        if (!transactionId) {
            return res.status(400).json({
                success: false,
                error: '취소 실패',
                detail: '유효한 TID를 찾을 수 없습니다.'
            });
        }

        // ✅ 나이스페이 결제 취소 요청
        const { data } = await axios.post(
            `${NICEPAY_BASE_URL}/payments/${transactionId}/cancel`,
            {
                orderId,
                amount,
                reason: reason || '고객 요청'
            },
            { headers: getAuthHeader() }
        );

        console.log('✅ 결제 취소 성공:', data);

        await client.query('BEGIN');

        // ✅ 주문 상태 변경
        await client.query(
            `UPDATE orders 
             SET payment_status = 'cancelled', 
                 cancelled_at = NOW(), 
                 cancel_reason = $1, 
                 updated_at = NOW() 
             WHERE order_id = $2`,
            [reason || '고객 요청', orderId]
        );

        // ✅ orders 테이블에서 product_id 조회
        const { rows: orderRows } = await client.query(
            `SELECT product_id FROM orders WHERE order_id = $1 LIMIT 1`,
            [orderId]
        );

        if (orderRows.length > 0 && orderRows[0].product_id) {
            const productId = orderRows[0].product_id;

            // ✅ 재고 복구
            await client.query(
                `UPDATE products 
         SET stock = stock + 1, updated_at = NOW()
         WHERE id = $1`,
                [productId]
            );
            // ✅ 재고 복구 후 대기열 처리
            if (orderRows.length > 0 && orderRows[0].product_id) {
                const productId = orderRows[0].product_id;

                // 재고 복구
                await client.query(
                    `UPDATE products 
                 SET stock = stock + 1, updated_at = NOW()
                 WHERE id = $1`,
                    [productId]
                );

                // Redis 재고 캐시 업데이트
                const stockKey = `product:${productId}:stock`;
                await redis.incr(stockKey);

                // 🔥 대기열 처리
                const queueKey = `queue:list:${productId}`;
                const firstWaiter = await redis.lindex(queueKey, 0); // 첫 번째 대기자 확인

                if (firstWaiter) {
                    // 첫 번째 대기자를 ready 상태로 변경
                    await redis.set(`queue:status:${firstWaiter}`, 'ready', 'EX', 60);
                    console.log(`📢 대기자 ${firstWaiter}에게 구매 기회 부여`);
                }

                console.log(`🔄 상품 ${productId} 재고 복원 및 대기열 처리 완료`);
            }
            console.log(`🔄 상품 ${productId} 재고 복원 완료`);
        } else {
            console.warn(`⚠️ 주문 ${orderId}의 상품 ID를 찾을 수 없습니다`);
        }

        // ✅ 배송 히스토리 추가
        await client.query(
            `INSERT INTO delivery_history (order_id, status, message, created_by)
             VALUES ($1, 'cancelled', '결제가 취소되었습니다.', 'system')`,
            [orderId]
        );

        await client.query('COMMIT');

        res.json({ success: true, data });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 결제 취소 실패:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: '결제 취소 실패',
            detail: error.response?.data || error.message
        });
    } finally {
        client.release();
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

router.post("/verify", async (req, res) => {
    const { orderId } = req.body;

    if (!orderId)
        return res.status(400).json({ success: false, message: "orderId 누락" });

    const client = await pool.connect();

    try {
        // ✅ 단순히 상태만 갱신
        const { rowCount } = await client.query(
            `
            UPDATE orders
            SET payment_status = 'paid',
                paid_at = NOW(),
                updated_at = NOW()
            WHERE order_id = $1
            `,
            [orderId]
        );

        if (rowCount === 0) {
            return res.status(404).json({
                success: false,
                message: "해당 주문을 찾을 수 없습니다.",
            });
        }

        console.log(`✅ 주문 ${orderId} 상태를 'paid'로 변경 완료`);

        return res.json({
            success: true,
            message: "결제 상태가 'paid'로 변경되었습니다.",
            orderId,
        });
    } catch (err) {
        console.error("결제 상태 변경 실패:", err.message);
        return res.status(500).json({
            success: false,
            message: "결제 상태 변경 중 오류 발생",
            error: err.message,
        });
    } finally {
        client.release();
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

// 🔥 재고 있으면 바로 구매 처리 API
router.post("/product/:productId/quick-purchase", async (req, res) => {
    try {
        const { productId } = req.params;
        const { userName, userEmail, userPhone, employeeId } = req.body;

        const stockKey = `product:${productId}:stock`;

        // 🔥 Redis 재고 차감
        const stock = await redis.decr(stockKey);

        if (stock < 0) {
            await redis.incr(stockKey);
            return res.json({
                success: false,
                outOfStock: true,
                message: "재고 없음"
            });
        }

        // 🔍 DB에서 상품 조회 (필수)
        const productResult = await pool.query(
            "SELECT name, price, stock FROM products WHERE id = $1",
            [productId]
        );

        const product = productResult.rows[0];

        if (!product) {
            throw new Error("상품을 찾을 수 없습니다.");
        }

        const { name: productName, price } = product;

        // 🔥 주문 ID 생성
        const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        const client = await pool.connect();
        await client.query("BEGIN");

        // 🔥 1️⃣ DB 재고 차감
        await client.query(
            "UPDATE products SET stock = stock - 1 WHERE id = $1",
            [productId]
        );

        // 🔥 2️⃣ 주문 INSERT
        await client.query(`
            INSERT INTO orders (
                order_id,
                employee_id,
                user_name,
                user_email,
                user_phone,
                product_id,
                product_name,
                product_price,
                total_amount,
                stock_snapshot,
                payment_status,
                created_at
            )
            VALUES (
                       $1, $2, $3, $4, $5,
                       $6, $7, $8, $9,
                       $10, 'pending', NOW()
                   )
        `, [
            orderId,
            employeeId || 'GUEST',
            userName || '미입력',
            userEmail,
            userPhone,
            productId,
            productName,
            price,            // product_price
            price,            // total_amount (※ 수량 1개라 단가 == 총금액)
            stock             // stock_snapshot
        ]);

        await client.query("COMMIT");
        client.release();

        // Redis 재고 캐시 삭제 → 다음 조회 시 DB 기준 다시 세팅
        await redis.del(stockKey);

        return res.json({
            success: true,
            orderId
        });

    } catch (err) {
        console.error("🔥 quick-purchase error:", err);
        return res.status(500).json({
            success: false,
            message: "바로 구매 처리 오류",
        });
    }
});

// 📦 재고 확인 API (캐시 사용)
// 📦 재고 확인 API (숫자 캐시 기반으로 통일)
router.get("/product/:productId/stock", async (req, res) => {
    const { productId } = req.params;

    try {
        console.log("📦 재고 확인 요청:", productId);

        const cacheKey = `product:${productId}:stock`;

        // 1️⃣ 캐시 확인 (정수 기반)
        const cached = await redis.get(cacheKey);

        if (cached !== null) {
            // cached는 문자열이므로 Number 변환
            const stock = Number(cached);
            return res.json({ success: true, stock });
        }

        // 2️⃣ 캐시 없으면 DB 조회
        const result = await pool.query(
            "SELECT stock FROM products WHERE id = $1",
            [productId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "상품을 찾을 수 없습니다."
            });
        }

        const stock = result.rows[0].stock;

        // 3️⃣ Redis에 정수로 캐싱 (TTL 10초)
        await redis.set(cacheKey, stock, 'EX', 10);

        return res.json({ success: true, stock });

    } catch (err) {
        console.error("❌ 재고 확인 오류:", err);
        return res.status(500).json({
            success: false,
            message: "재고 확인 오류"
        });
    }
});

// 🛒 직접 주문 생성 API (재고 있을 때)
router.post('/order/create', async (req, res) => {
    try {
        const { productId, employeeId, userName, userEmail, userPhone } = req.body;

        console.log("🛒 직접 주문 생성 요청:", { productId, userEmail });

        // ✅ 필수 데이터 검증
        if (!productId) {
            return res.status(400).json({
                success: false,
                message: "productId가 필요합니다."
            });
        }
        if (!userEmail) {
            return res.status(400).json({
                success: false,
                message: "userEmail이 필요합니다."
            });
        }

        // 🔥 orderQueue에 job 추가
        const job = await orderQueue.add(
            "createOrder",
            {
                productId,
                employeeId: employeeId || "GUEST",
                userName: userName || "미입력",
                userEmail,
                userPhone: userPhone || null,
            },
            {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 2000
                }
            }
        );

        console.log(`✅ 큐에 주문 등록: jobId=${job.id}`);

        // 🔄 job 완료 대기 (최대 30초)
        const result = await job.waitUntilFinished(
            orderQueue.events,
            30000
        );

        if (!result || !result.orderId) {
            throw new Error("주문 생성 실패");
        }

        // 🔥 재고 캐시 무효화
        await redis.del(`product:${productId}:stock`);

        res.json({
            success: true,
            orderId: result.orderId,
            message: "주문이 생성되었습니다."
        });

    } catch (err) {
        console.error("❌ 직접 주문 생성 실패:", err);
        res.status(500).json({
            success: false,
            message: err.message || "주문 생성 중 오류가 발생했습니다."
        });
    }
});

// 🔄 기존 /queue/init 수정 (재고 없을 때만 대기열)
import { v4 as uuid } from 'uuid';

router.post('/queue/init', async (req, res) => {
    try {
        const { productId } = req.body;

        const jobId = uuid();

        // 1) 큐 push
        await redis.rpush(`queue:list:${productId}`, jobId);

        // 2) 🔥 jobId → productId 매핑 (필수)
        await redis.set(`queue:map:${jobId}`, productId);

        // 3) 현재 대기 번호 계산
        const waiting = await redis.llen(`queue:list:${productId}`);

        res.json({
            success: true,
            jobId,
            position: waiting
        });

    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

// 🔄 수정된 queue/status 엔드포인트
router.get('/queue/status/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;

        // 1) jobId → productId 조회
        const productId = await redis.get(`queue:map:${jobId}`);

        // productId가 없다는 건?
        // → 이미 pop된 상태 = 내 차례 = ready
        if (!productId) {
            return res.json({
                status: 'ready',
                position: 0
            });
        }

        // 2) queue list에서 현재 위치 확인
        const listKey = `queue:list:${productId}`;
        const list = await redis.lrange(listKey, 0, -1);

        // index 계산 (동적으로 매번)
        const idx = list.indexOf(jobId);

        // 3) 리스트 안에 있으면 → waiting 상태
        if (idx >= 0) {
            return res.json({
                status: 'waiting',
                position: idx + 1
            });
        }

        // 4) 리스트에서 빠졌는데 map도 없으면 → ready
        return res.json({
            status: 'ready',
            position: 0
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({
            status: 'failed',
            error: '상태 조회 오류'
        });
    }
});
export default router;
