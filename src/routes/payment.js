import express from 'express';
import axios from 'axios';
import crypto from 'crypto';

const router = express.Router();

// 나이스페이 테스트용 계정 (실제 계정으로 교체)
const NICEPAY_BASE_URL = 'https://api.nicepay.co.kr/v1';
const NICEPAY_CLIENT_KEY = 'S2_bc8d3fb863da4ed29a3b838d6ff4dbaf';
const NICEPAY_SECRET_KEY = '1d259c40e7074ae99e7cd8bb71a53e64';

// 🔹 Basic 인증 토큰 생성
function getAuthHeader() {
    const basicToken = Buffer.from(`${NICEPAY_CLIENT_KEY}:${NICEPAY_SECRET_KEY}`).toString('base64');
    return { Authorization: `Basic ${basicToken}`, 'Content-Type': 'application/json' };
}

// 🔹 결제 요청 (결제창 생성)
router.post('/request', async (req, res) => {
    try {
        const { orderId, amount, buyerName, buyerEmail, buyerTel, productName, returnUrl } = req.body;

        const { data } = await axios.post(
            `${NICEPAY_BASE_URL}/payments`,
            {
                orderId,
                amount,
                goodsName: productName,
                returnUrl,
                buyerName,
                buyerEmail,
                buyerTel,
                payMethod: 'CARD',
            },
            { headers: getAuthHeader() }
        );

        res.json({ result: data });
    } catch (error) {
        console.error('결제 요청 실패:', error.response?.data || error.message);
        res.status(500).json({ error: '결제 요청 실패', detail: error.response?.data });
    }
});

// 🔹 결제 승인 콜백 처리
router.post('/callback', async (req, res) => {
    try {
        const { tid, orderId, amount } = req.body;
        const { data } = await axios.post(
            `${NICEPAY_BASE_URL}/payments/${tid}/confirm`,
            { amount, orderId },
            { headers: getAuthHeader() }
        );

        console.log('✅ 결제 승인 성공:', data);
        res.json({ success: true, data });
    } catch (error) {
        console.error('결제 승인 실패:', error.response?.data || error.message);
        res.status(500).json({ error: '결제 승인 실패' });
    }
});

export default router;