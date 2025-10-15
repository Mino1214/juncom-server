// services/AddressService.js
import axios from 'axios';

class AddressService {
    constructor() {
        // Kakao REST API Key (환경변수로 관리 권장)
        this.kakaoApiKey = 'b78ae2925790c4c5606a66f8d79dd7b0';
        this.kakaoApiUrl = 'https://dapi.kakao.com/v2/local/search/address.json';
    }

    async searchAddress(keyword) {
        try {
            const response = await axios.get(this.kakaoApiUrl, {
                headers: {
                    'Authorization': `KakaoAK ${this.kakaoApiKey}`
                },
                params: {
                    query: keyword,
                    size: 10, // 검색 결과 개수 (최대 30)
                }
            });

            console.log('✅ 주소 검색 성공:', keyword);
            return {
                success: true,
                documents: response.data.documents,
                meta: response.data.meta
            };
        } catch (error) {
            console.error('❌ 주소 검색 실패:', error.response?.data || error.message);
            throw error;
        }
    }

    async searchAddressByCoordinate(longitude, latitude) {
        try {
            const response = await axios.get('https://dapi.kakao.com/v2/local/geo/coord2address.json', {
                headers: {
                    'Authorization': `KakaoAK ${this.kakaoApiKey}`
                },
                params: {
                    x: longitude,
                    y: latitude
                }
            });

            console.log('✅ 좌표로 주소 검색 성공');
            return {
                success: true,
                documents: response.data.documents,
                meta: response.data.meta
            };
        } catch (error) {
            console.error('❌ 좌표 주소 검색 실패:', error.response?.data || error.message);
            throw error;
        }
    }
}

export default new AddressService();