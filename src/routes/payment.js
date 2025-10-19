import express from 'express';
import axios from 'axios';
import crypto from 'crypto';

const router = express.Router();

// 나이스페이 설정
const NICEPAY_BASE_URL = 'https://api.nicepay.co.kr/v1';
const NICEPAY_CLIENT_ID = 'R2_a924dce2ab1f4d5ba20ebe9f03757c2c';  // clientId
const NICEPAY_SECRET_KEY = '8e549fad27bf441298b46b4d287de274';

// 🔹 Basic 인증 토큰 생성
function getAuthHeader() {
    const basicToken = Buffer.from(`${NICEPAY_CLIENT_ID}:${NICEPAY_SECRET_KEY}`).toString('base64');
    return {
        'Authorization': `Basic ${basicToken}`,
        'Content-Type': 'application/json'
    };
}

// 🔹 결제 요청 (프론트엔드에 결제 정보 반환)
router.post('/request', async (req, res) => {
    try {
        const { orderId, amount, buyerName, buyerEmail, buyerTel, productName, returnUrl } = req.body;

        // 프론트엔드에서 AUTHNICE.requestPay()에 사용할 정보 반환
        res.json({
            success: true,
            result: {
                clientId: NICEPAY_CLIENT_ID,
                orderId: orderId,
                amount: amount,
                goodsName: productName,
                returnUrl: returnUrl,
                buyerName: buyerName,
                buyerEmail: buyerEmail,
                buyerTel: buyerTel
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
router.post('/result', async (req, res) => {
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

        // TODO: 데이터베이스에 주문 정보 저장
        // await saveOrderToDatabase(data);

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
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    console.log('====================================');
    console.log('🔔 나이스페이 웹훅 수신!');
    console.log('====================================');

    try {
        // 1. 헤더 정보 로깅
        console.log('📋 Headers:', req.headers);

        // 2. Body 파싱 (raw body를 받은 경우)
        let webhookData;
        if (Buffer.isBuffer(req.body)) {
            webhookData = JSON.parse(req.body.toString());
        } else {
            webhookData = req.body;
        }

        // 3. 받은 데이터 상세 로깅
        console.log('📦 Webhook Data:', JSON.stringify(webhookData, null, 2));

        // 4. 주요 필드 추출 및 로깅 (예상되는 필드들)
        const {
            resultCode,
            resultMsg,
            tid,
            orderId,
            amount,
            payMethod,
            status,
            approvalDate,
            cardCode,
            cardName,
            cardNo,
            buyerName,
            buyerEmail,
            buyerTel,
            goodsName,
            mallId,
            // 추가로 올 수 있는 필드들
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
        console.log('승인일시 (approvalDate):', approvalDate);
        console.log('카드사 (cardName):', cardName);
        console.log('구매자명 (buyerName):', buyerName);
        console.log('구매자 이메일 (buyerEmail):', buyerEmail);
        console.log('구매자 연락처 (buyerTel):', buyerTel);
        console.log('상품명 (goodsName):', goodsName);

        // 기타 필드가 있으면 로깅
        if (Object.keys(otherFields).length > 0) {
            console.log('==== 기타 필드 ====');
            console.log(otherFields);
        }

        // 5. 웹훅 타입 확인 (결제 성공, 실패, 취소 등)
        if (resultCode === '0000' || status === 'paid') {
            console.log('✅ 결제 성공 웹훅');

            // TODO: 결제 성공 처리 로직
            // - 데이터베이스에 결제 정보 저장
            // - 주문 상태 업데이트
            // - 재고 차감
            // - 이메일 발송 등

        } else if (status === 'cancelled' || status === 'refunded') {
            console.log('❌ 결제 취소/환불 웹훅');

            // TODO: 취소/환불 처리 로직
            // - 데이터베이스 상태 업데이트
            // - 재고 복구
            // - 알림 발송 등

        } else {
            console.log('⚠️ 기타 상태 웹훅:', status || resultCode);
        }

        // 6. 타임스탬프와 함께 파일로 저장 (디버깅용)
        const fs = require('fs').promises;
        const logFileName = `webhook_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        const logPath = `./logs/webhooks/${logFileName}`;

        try {
            // logs/webhooks 디렉토리 생성
            await fs.mkdir('./logs/webhooks', { recursive: true });

            // 웹훅 데이터를 파일로 저장
            await fs.writeFile(logPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                headers: req.headers,
                body: webhookData
            }, null, 2));

            console.log(`💾 웹훅 데이터 저장됨: ${logPath}`);
        } catch (fileError) {
            console.error('파일 저장 실패:', fileError);
        }

        console.log('====================================');

        // 7. 나이스페이에 성공 응답 (중요!)
        // 나이스페이는 HTTP 200 응답을 받아야 웹훅 재시도를 하지 않음
        res.status(200).json({
            success: true,
            message: 'Webhook received successfully'
        });

    } catch (error) {
        console.error('❌ 웹훅 처리 에러:', error);
        console.error('Error Stack:', error.stack);

        // 에러가 발생해도 200을 반환하여 재시도 방지
        // 실제 운영에서는 에러 상황에 따라 적절히 처리
        res.status(200).json({
            success: false,
            error: error.message
        });
    }
});

// 🔹 웹훅 로그 조회 API (디버깅용)
router.get('/webhook/logs', async (req, res) => {
    try {
        const fs = require('fs').promises;
        const path = require('path');

        // 로그 디렉토리 읽기
        const logDir = './logs/webhooks';
        const files = await fs.readdir(logDir);

        // 최근 10개 파일만 읽기
        const recentFiles = files
            .filter(f => f.endsWith('.json'))
            .sort((a, b) => b.localeCompare(a))
            .slice(0, 10);

        const logs = [];
        for (const file of recentFiles) {
            const content = await fs.readFile(path.join(logDir, file), 'utf8');
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
        // 테스트용 웹훅 데이터
        const testWebhookData = {
            resultCode: '0000',
            resultMsg: '정상 처리되었습니다.',
            tid: 'test_' + Date.now(),
            orderId: 'ORD_' + Date.now(),
            amount: 10000,
            payMethod: 'CARD',
            status: 'paid',
            approvalDate: new Date().toISOString(),
            cardCode: '01',
            cardName: '테스트카드',
            cardNo: '1234****5678',
            buyerName: '홍길동',
            buyerEmail: 'test@example.com',
            buyerTel: '010-1234-5678',
            goodsName: '테스트 상품',
            mallId: 'test_mall'
        };

        // 자기 자신의 웹훅 엔드포인트 호출
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

export default router;