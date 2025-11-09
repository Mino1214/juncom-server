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



export default router;