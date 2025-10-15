// services/AddressService.js
import axios from 'axios';

class AddressService {
    constructor() {
        // Kakao REST API Key (환경변수로 관리 권장)
        this.kakaoApiKey = 'b78ae2925790c4c5606a66f8d79dd7b0';
        this.kakaoApiUrl = 'https://dapi.kakao.com/v2/local/search/address.json';
        this.keywordApiUrl = 'https://dapi.kakao.com/v2/local/search/keyword.json'; // 추가
    }

    async searchAddress(keyword) {
        try {
            // 1. 주소 검색
            const addressResponse = await fetch(`${this.addressApiUrl}?query=${encodeURIComponent(keyword)}&size=30`, {
                headers: {
                    'Authorization': `KakaoAK ${this.kakaoApiKey}`
                }
            });
            const addressData = await addressResponse.json();

            // 2. 키워드 검색 (장소/건물명)
            const keywordResponse = await fetch(`${this.keywordApiUrl}?query=${encodeURIComponent(keyword)}&size=15`, {
                headers: {
                    'Authorization': `KakaoAK ${this.kakaoApiKey}`
                }
            });
            const keywordData = await keywordResponse.json();

            // 3. 두 결과 합치기
            const allDocuments = [
                ...(addressData.documents || []),
                ...(keywordData.documents || []).map(place => ({
                    address_name: place.address_name,
                    address_type: 'PLACE',
                    road_address: place.road_address_name ? {
                        address_name: place.road_address_name,
                        building_name: place.place_name
                    } : null,
                    address: {
                        address_name: place.address_name
                    },
                    place_name: place.place_name,
                    category_name: place.category_name
                }))
            ];

            console.log('✅ 주소 검색 성공:', keyword, `(${allDocuments.length}개)`);

            return {
                success: true,
                documents: allDocuments,
                meta: {
                    total_count: allDocuments.length,
                    is_end: true
                }
            };
        } catch (error) {
            console.error('❌ 주소 검색 실패:', error.message);
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