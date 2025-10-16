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

export default router;