// routes/address.js (또는 기존 routes 파일에 추가)
import express from 'express';
import AddressService from "../address.service.js";

const router = express.Router();

// 주소 검색 API
router.get('/api/address/search', async (req, res) => {
    try {
        const { keyword } = req.query;

        // 검색어 유효성 검사
        if (!keyword || keyword.trim().length === 0) {
            return res.status(400).json({
                success: false,
                message: '검색어를 입력해주세요.'
            });
        }

        // 검색어가 너무 짧은 경우
        if (keyword.trim().length < 2) {
            return res.status(400).json({
                success: false,
                message: '검색어는 최소 2글자 이상 입력해주세요.'
            });
        }

        // 주소 검색 실행
        const result = await AddressService.searchAddress(keyword);

        // 검색 결과가 없는 경우
        if (!result.documents || result.documents.length === 0) {
            return res.status(200).json({
                success: true,
                documents: [],
                meta: result.meta,
                message: '검색 결과가 없습니다.'
            });
        }

        // 성공 응답
        return res.status(200).json({
            success: true,
            documents: result.documents,
            meta: result.meta
        });

    } catch (error) {
        console.error('주소 검색 API 오류:', error);

        // Kakao API 에러 처리
        if (error.response) {
            return res.status(error.response.status).json({
                success: false,
                message: 'Kakao API 오류가 발생했습니다.',
                error: error.response.data
            });
        }

        // 일반 서버 에러
        return res.status(500).json({
            success: false,
            message: '주소 검색 중 오류가 발생했습니다.'
        });
    }
});

// 좌표로 주소 검색 API (선택사항)
router.get('/api/address/coord2address', async (req, res) => {
    try {
        const { longitude, latitude } = req.query;

        if (!longitude || !latitude) {
            return res.status(400).json({
                success: false,
                message: '경도와 위도를 입력해주세요.'
            });
        }

        const result = await AddressService.searchAddressByCoordinate(longitude, latitude);

        return res.status(200).json({
            success: true,
            documents: result.documents,
            meta: result.meta
        });

    } catch (error) {
        console.error('좌표 주소 검색 API 오류:', error);
        return res.status(500).json({
            success: false,
            message: '주소 검색 중 오류가 발생했습니다.'
        });
    }
});


// ✅ 관리자용 주문 현황 조회 API
router.get("/api/all/orders", async (req, res) => {
    const client = await pool.connect();
    try {
        const result = await client.query(`
      SELECT 
        o.order_id,
        o.user_name AS buyer,
        o.total_amount AS transaction_amount,
        o.payment_status,
        o.created_at AS approved_at,
        o.cancelled_at AS cancelled_at,
        o.payment_method,
        p.goods_name AS product_name,
        p.tid,
        p.cancel_reason
      FROM orders o
      LEFT JOIN payment_logs p ON o.order_id = p.order_id
      ORDER BY o.created_at DESC
      LIMIT 200
    `);

        res.json({
            success: true,
            count: result.rows.length,
            orders: result.rows.map((row, idx) => ({
                no: idx + 1,
                결제수단: row.payment_method || "신용카드",
                거래상태: row.payment_status === "cancelled" ? "전체취소" : "정상",
                승인일자: row.approved_at,
                취소일자: row.cancelled_at,
                거래금액: row.transaction_amount ? -Math.abs(row.transaction_amount) : 0,
                상품명: row.product_name,
                주문번호: row.order_id,
                구매자: row.buyer,
                취소사유: row.cancel_reason || "-",
            })),
        });
    } catch (err) {
        console.error("❌ 관리자 주문 조회 실패:", err);
        res.status(500).json({ success: false, message: "서버 오류" });
    } finally {
        client.release();
    }
});
export default router;